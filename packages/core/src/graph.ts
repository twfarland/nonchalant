// The reactive graph: alien-signals' node layer (computed / effect / flush
// queue; upstream src/index.ts, MIT © Johnson Chu) adapted to nonchalant, plus
// the piece alien-signals does not have — `source`, a state root that wakes
// readers per *path*: every publish reconciles prev → next and only dirties
// the readers whose recorded read-paths intersect the patch ("write plain,
// read tracked" — see docs/concepts.md).
//
// Mechanism: each (source, reader) pair gets a hidden *gate* — an ordinary
// signal node whose value is a change epoch. publish() bumps only the gates
// whose PathTree the patch affects; everything downstream is stock
// alien-signals propagation with its equality cuts, so the ported core in
// system.ts stays untouched.
//
// Scheduling differs from upstream: writes never flush synchronously — a
// flush is scheduled on the microtask queue (one per burst), and flush() is
// exported for a manual synchronous drain. Derives are pull-based and always
// read consistently regardless of flush timing.
//
// A publish that lands while a reader is mid-run cannot be judged then: the
// run's final read-set is unknowable (reads later in the run still see the
// pre-publish snapshot through the open recorder). Those publishes are parked
// on the gate and judged in finalizeGates against the freshly sealed paths.
//
// Internal module: the public faces are `derive` / `flush` (index.ts, M2) and
// the process runtime (M3).

import {
  createReactiveSystem,
  MUTABLE,
  WATCHING,
  RECURSED_CHECK,
  DIRTY,
  PENDING,
  type Link,
  type ReactiveNode,
} from './system.ts'
import { parsePath, reconcile, type Json, type Op } from './reconcile.ts'
import { affects, createRecorder, type PathTree, type Recorder } from './track.ts'

interface EffectNode extends ReactiveNode {
  fn: () => void | (() => void)
  cleanup: (() => void) | void
}

interface ComputedNode<T = unknown> extends ReactiveNode {
  value: T | undefined
  getter: (previousValue?: T) => T
}

interface SignalNode<T = unknown> extends ReactiveNode {
  currentValue: T
  pendingValue: T
  gate?: Gate
}

interface SourceState {
  snapshot: Json
  gates: Map<ReactiveNode, Gate>
  onWatchers: ((count: number) => void) | undefined
}

interface Gate {
  node: SignalNode<number>
  source: SourceState
  reader: ReactiveNode
  paths: PathTree | null
  recorder: Recorder | null
  // ops published while `recorder` was open, judged at finalizeGates
  deferredOps: Op[]
  deferredSegs: string[][]
}

// Marks a parent whose deps include at least one child effect, gating the
// dispose-children slow path. Outside system.ts's flag range (upstream trick).
const HAS_CHILD_EFFECT = 64

let cycle = 0
let runDepth = 0
let notifyIndex = 0
let queuedLength = 0
let activeSub: ReactiveNode | undefined

const queued: (EffectNode | undefined)[] = []

// Gates whose recorder is open for the currently running reader body; used as
// a stack so nested runs finalize only their own recordings.
const openGates: Gate[] = []

function enqueue(node: ReactiveNode): void {
  let insertIndex = queuedLength
  let firstInsertedIndex = insertIndex
  let e: EffectNode | undefined = node as EffectNode
  do {
    queued[insertIndex++] = e
    e.flags &= ~WATCHING
    e = e.subs?.sub as EffectNode | undefined
  } while (e !== undefined && e.flags & WATCHING)
  queuedLength = insertIndex
  // reverse the inserted run so parent effects run before their children
  while (firstInsertedIndex < --insertIndex) {
    const left = queued[firstInsertedIndex]
    queued[firstInsertedIndex++] = queued[insertIndex]
    queued[insertIndex] = left
  }
}

const { link, unlink, propagate, checkDirty, shallowPropagate } = createReactiveSystem({
  update(node: ReactiveNode): boolean {
    if ('getter' in node) return updateComputed(node as ComputedNode)
    if ('currentValue' in node) return updateSignal(node as SignalNode)
    node.flags = MUTABLE
    return true
  },
  notify: enqueue,
  unwatched(node: ReactiveNode): void {
    if ('getter' in node) {
      if (node.depsTail !== undefined) {
        node.flags = MUTABLE | DIRTY
        disposeAllDepsInReverse(node)
      }
    } else if ('currentValue' in node) {
      const gate = (node as SignalNode).gate
      if (gate !== undefined) {
        gate.source.gates.delete(gate.reader)
        gate.source.onWatchers?.(gate.source.gates.size)
      }
    } else if ('fn' in node) {
      disposeEffect(node as EffectNode)
    }
  },
})

// ---------- sources ----------

export interface Source<T extends Json> {
  /** Snapshot read. Tracked (path-recording proxy) inside derive/effect bodies; the raw snapshot elsewhere. */
  (): T
  /** Publish the next immutable snapshot; wakes only readers whose paths the patch touches. */
  publish(next: T): void
}

export function source<T extends Json>(
  initial: T,
  hooks?: { onWatchers?: (count: number) => void },
): Source<T> {
  const state: SourceState = { snapshot: initial, gates: new Map(), onWatchers: hooks?.onWatchers }

  const read = (): T => {
    const sub = activeSub
    if (sub === undefined) return state.snapshot as T
    let gate = state.gates.get(sub)
    if (gate === undefined) {
      const node: SignalNode<number> = {
        currentValue: 0,
        pendingValue: 0,
        deps: undefined,
        depsTail: undefined,
        subs: undefined,
        subsTail: undefined,
        flags: MUTABLE,
      }
      gate = { node, source: state, reader: sub, paths: null, recorder: null, deferredOps: [], deferredSegs: [] }
      node.gate = gate
      state.gates.set(sub, gate)
      state.onWatchers?.(state.gates.size)
    }
    const node = gate.node
    if (node.flags & DIRTY) {
      if (updateSignal(node)) {
        const subs = node.subs
        if (subs !== undefined) shallowPropagate(subs)
      }
    }
    link(node, sub, cycle)
    if (gate.recorder === null) {
      gate.recorder = createRecorder()
      openGates.push(gate)
    }
    return gate.recorder.wrap(state.snapshot) as T
  }

  const publish = (next: T): void => {
    const patch = reconcile(state.snapshot, next)
    state.snapshot = next
    if (patch.length === 0) return
    const segsList = patch.map((op) => parsePath(op[1]))
    // O(watchers) scan; an inverted path index would make it O(affected) —
    // headroom, not needed at documented scales (reconcile.perf budget)
    for (const gate of state.gates.values()) {
      if (gate.recorder !== null) {
        // reader mid-run: park the ops, finalizeGates judges them
        for (let i = 0; i < patch.length; i++) {
          gate.deferredOps.push(patch[i]!)
          gate.deferredSegs.push(segsList[i]!)
        }
        continue
      }
      // recorder === null ⇒ paths !== null (finalizeGates runs in every reader's finally)
      if (gate.paths !== null && !affects(gate.paths, patch, segsList)) continue
      wakeGate(gate)
    }
  }

  return Object.assign(read, { publish })
}

function wakeGate(gate: Gate): void {
  const node = gate.node
  node.pendingValue = node.pendingValue + 1
  node.flags = MUTABLE | DIRTY
  const subs = node.subs
  if (subs !== undefined) {
    propagate(subs, runDepth !== 0)
    scheduleFlush()
  }
}

function finalizeGates(mark: number): void {
  while (openGates.length > mark) {
    const gate = openGates.pop()!
    gate.paths = gate.recorder!.finalize()
    gate.recorder = null
    if (gate.deferredOps.length !== 0) {
      const ops = gate.deferredOps
      const segs = gate.deferredSegs
      gate.deferredOps = []
      gate.deferredSegs = []
      // callers clear RECURSED_CHECK before finalizing, so this wake notifies normally
      if (affects(gate.paths, ops, segs)) wakeGate(gate)
    }
  }
}

// ---------- computeds ----------

export interface ComputedHandle<T> {
  read(): T
  peek(): T | undefined
  dispose(): void
}

export function computed<T>(getter: (previousValue?: T) => T): ComputedHandle<T> {
  const node: ComputedNode<T> = {
    value: undefined,
    getter,
    deps: undefined,
    depsTail: undefined,
    subs: undefined,
    subsTail: undefined,
    flags: 0,
  }
  return {
    read: () => computedOper(node),
    peek: () => node.value,
    dispose: () => {
      // detach subscribers first: a live effect's dep list must not pin the disposed node
      let l: Link | undefined = node.subs
      while (l !== undefined) {
        const next: Link | undefined = l.nextSub
        unlink(l, l.sub)
        l = next
      }
      node.flags = 0
      disposeAllDepsInReverse(node)
    },
  }
}

function updateComputed<T>(c: ComputedNode<T>): boolean {
  if (c.flags & HAS_CHILD_EFFECT) pruneChildEffects(c)
  c.depsTail = undefined
  c.flags = MUTABLE | RECURSED_CHECK
  const prevSub = activeSub
  activeSub = c
  const mark = openGates.length
  try {
    ++cycle
    const oldValue = c.value
    return oldValue !== (c.value = c.getter(oldValue))
  } finally {
    activeSub = prevSub
    c.flags &= ~RECURSED_CHECK
    finalizeGates(mark)
    purgeDeps(c)
  }
}

function computedOper<T>(c: ComputedNode<T>): T {
  const flags = c.flags
  if (
    flags & DIRTY ||
    (flags & PENDING && (checkDirty(c.deps!, c) || ((c.flags = flags & ~PENDING), false)))
  ) {
    if (updateComputed(c)) {
      const subs = c.subs
      if (subs !== undefined) shallowPropagate(subs)
    }
  } else if (flags === 0) {
    // cold first read
    c.flags = MUTABLE | RECURSED_CHECK
    const prevSub = activeSub
    activeSub = c
    const mark = openGates.length
    try {
      c.value = c.getter()
    } finally {
      activeSub = prevSub
      c.flags &= ~RECURSED_CHECK
      finalizeGates(mark)
    }
  }
  const sub = activeSub
  if (sub !== undefined) link(c, sub, cycle)
  return c.value as T
}

// ---------- signals (gates) ----------

function updateSignal(s: SignalNode): boolean {
  s.flags = MUTABLE
  return s.currentValue !== (s.currentValue = s.pendingValue)
}

// ---------- effects ----------

/** Run fn now and on every wake; returns a disposer. fn may return a cleanup run before each re-run and on dispose. */
export function effect(fn: () => void | (() => void)): () => void {
  const e: EffectNode = {
    fn,
    cleanup: undefined,
    deps: undefined,
    depsTail: undefined,
    subs: undefined,
    subsTail: undefined,
    flags: WATCHING | RECURSED_CHECK,
  }
  const prevSub = activeSub
  activeSub = e
  if (prevSub !== undefined) {
    link(e, prevSub, 0)
    prevSub.flags |= HAS_CHILD_EFFECT
  }
  const mark = openGates.length
  try {
    ++runDepth
    e.cleanup = e.fn()
  } finally {
    --runDepth
    activeSub = prevSub
    e.flags &= ~RECURSED_CHECK
    finalizeGates(mark)
  }
  requeueIfDirtied(e)
  return () => disposeEffect(e)
}

/** An inner publish reaching a running effect through a computed sets PENDING without queueing (RECURSED_CHECK was up) — catch it once the run is over. */
function requeueIfDirtied(e: EffectNode): void {
  const flags = e.flags
  // WATCHING absent ⇒ disposed, or already queued by a finalizeGates wake
  if (flags & WATCHING && flags & (DIRTY | PENDING)) {
    enqueue(e)
    scheduleFlush()
  }
}

function run(e: EffectNode): void {
  const flags = e.flags
  if (flags & DIRTY || (flags & PENDING && checkDirty(e.deps!, e))) {
    if (flags & HAS_CHILD_EFFECT) pruneChildEffects(e)
    if (e.cleanup) {
      runCleanup(e)
      if (!e.flags) return // disposed by its own cleanup
    }
    e.depsTail = undefined
    e.flags = WATCHING | RECURSED_CHECK
    const prevSub = activeSub
    activeSub = e
    const mark = openGates.length
    try {
      ++cycle
      ++runDepth
      e.cleanup = e.fn()
    } finally {
      --runDepth
      activeSub = prevSub
      e.flags &= ~RECURSED_CHECK
      finalizeGates(mark)
      purgeDeps(e)
    }
    requeueIfDirtied(e)
  } else if (e.deps !== undefined) {
    e.flags = WATCHING | (flags & HAS_CHILD_EFFECT)
  }
}

function runCleanup(e: EffectNode): void {
  const cleanup = e.cleanup as () => void
  e.cleanup = undefined
  const prevSub = activeSub
  activeSub = undefined
  try {
    cleanup()
  } finally {
    activeSub = prevSub
  }
}

function disposeEffect(e: EffectNode): void {
  e.flags = 0
  disposeAllDepsInReverse(e)
  const sub = e.subs
  if (sub !== undefined) unlink(sub)
  if (e.cleanup) runCleanup(e)
}

/** Detach child-effect deps (they are owned, not read) before a re-run. */
function pruneChildEffects(sub: ReactiveNode): void {
  let l = sub.depsTail
  while (l !== undefined) {
    const prev = l.prevDep
    const dep = l.dep
    if (!('getter' in dep) && !('currentValue' in dep)) unlink(l, sub)
    l = prev
  }
}

function disposeAllDepsInReverse(sub: ReactiveNode): void {
  let l = sub.depsTail
  while (l !== undefined) {
    const prev = l.prevDep
    unlink(l, sub)
    l = prev
  }
}

/** Remove deps not re-read during the run that just ended. */
function purgeDeps(sub: ReactiveNode): void {
  const depsTail = sub.depsTail
  let dep = depsTail !== undefined ? depsTail.nextDep : sub.deps
  while (dep !== undefined) {
    dep = unlink(dep, sub)
  }
}

// ---------- scheduling ----------

let flushScheduled = false
let flushing = false

function scheduleFlush(): void {
  // wakes raised mid-flush are drained by the running loop — no microtask needed
  if (flushScheduled || flushing) return
  flushScheduled = true
  // Promise, not queueMicrotask: pure ES, keeps core free of host-specific APIs
  Promise.resolve().then(() => {
    flushScheduled = false
    flush()
  })
}

/** Drain pending effect notifications now. Publishes otherwise batch to one flush per microtask. */
export function flush(): void {
  const prevFlushing = flushing
  flushing = true
  let firstError: unknown
  let errored = false
  try {
    while (notifyIndex < queuedLength) {
      const e = queued[notifyIndex]!
      queued[notifyIndex++] = undefined
      try {
        run(e)
      } catch (error) {
        // one effect throwing must not strand the ones queued behind it
        if (!errored) {
          errored = true
          firstError = error
        }
      }
    }
  } finally {
    flushing = prevFlushing
    notifyIndex = 0
    queuedLength = 0
  }
  if (errored) throw firstError
}

/** Run fn with dependency tracking suspended — the "pull, don't subscribe" escape hatch. */
export function untracked<T>(fn: () => T): T {
  const prevSub = activeSub
  activeSub = undefined
  try {
    return fn()
  } finally {
    activeSub = prevSub
  }
}
