// The reactive graph: alien-signals' node layer (computed / effect / flush
// queue; upstream src/index.ts, MIT © Johnson Chu) adapted to nonchalant, plus
// the piece alien-signals does not have — `source`, a state root that wakes
// readers per *path*: every publish reconciles prev → next and only dirties
// the readers whose recorded read-paths intersect the patch ("write plain,
// read tracked" — see docs/concepts.md). Discovering the patch (reconcile)
// and publishing it (`commit`: install, then invalidate) are separate steps,
// so a producer that already knows its changes skips the diff.
//
// Mechanism: each (source, reader) pair gets a hidden *gate* — an ordinary
// signal node whose value is a change epoch. publish() bumps only the gates
// whose PathTree the patch affects; everything downstream is stock
// alien-signals propagation with its equality cuts, so the ported core in
// system.ts stays untouched.
//
// Derives are pull-based and always read consistently regardless of flush
// timing; the effect queue and its microtask scheduling live in queue.ts.
// Watchers are gates whose reader is *watched* (watch.ts).
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
import { reconcile, type Json, type Op, type Patch } from './reconcile.ts'
import { parsePath } from './pointer.ts'
import { affects, type PathTree } from './paths.ts'
import { createRecorder, handed, type Recorder } from './track.ts'
import { unproxy, unwrap } from './unwrap.ts'
import { count, isWatched, rewatch, type Counted, type Stamped } from './watch.ts'
import { drain, enqueue, schedule } from './queue.ts'

interface EffectNode extends ReactiveNode {
  fn: () => void | (() => void)
  cleanup: (() => void) | void
}

interface ComputedNode<T = unknown> extends Stamped {
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
  watched: number
  onWatchers: ((count: number) => void) | undefined
}

interface Gate extends Counted {
  node: SignalNode<number>
  source: SourceState
  reader: ReactiveNode
  paths: PathTree | null
  recorder: Recorder | null
  // ops published while `recorder` was open, judged (and parsed: the rare path) at finalizeGates
  deferred: Op[]
}

// Marks a parent whose deps include at least one child effect, gating the
// dispose-children slow path. Outside system.ts's flag range (upstream trick).
const HAS_CHILD_EFFECT = 64

let cycle = 0
let runDepth = 0
let activeSub: ReactiveNode | undefined

// Gates whose recorder is open for the currently running reader body; used as
// a stack so nested runs finalize only their own recordings.
const openGates: Gate[] = []


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
        count(gate, false)
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
  /**
   * Publish a transition whose changes are already known: install `next` and
   * invalidate readers by `patch`, with no diff. `patch` must take `base` to
   * `next` (applyPatch(base, patch) equals next) and `base` must be the
   * current snapshot — a patch means nothing against any other, so a stale
   * base throws before anything is installed. Internal: no public face.
   */
  commit(base: T, next: T, patch: Patch): void
}

export function source<T extends Json>(
  initial: T,
  hooks?: { onWatchers?: (count: number) => void },
): Source<T> {
  const state: SourceState = { snapshot: initial, gates: new Map(), watched: 0, onWatchers: hooks?.onWatchers }

  const read = (): T => {
    const sub = activeSub
    if (sub === undefined) return state.snapshot as T
    const gate = state.gates.get(sub) ?? openGate(state, sub)
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

  // discovery: a reader-less source installs without diffing — the patch
  // would only be matched against gates, and a reader that arrives later
  // records against whatever snapshot is current then
  const publish = (next: T): void => {
    const prev = state.snapshot
    state.snapshot = next
    if (state.gates.size !== 0) invalidate(state, reconcile(prev, next))
  }

  // publication, from changes a producer already has; identity is the
  // revision check (snapshots are immutable, so an equal base is the same state)
  const commit = (base: T, next: T, patch: Patch): void => {
    if (!Object.is(base, state.snapshot)) throw new Error('nonchalant: commit base is not the current snapshot')
    state.snapshot = next
    if (state.gates.size !== 0) invalidate(state, patch)
  }

  return Object.assign(read, { publish, commit })
}

/**
 * Wake the gates `patch` affects. The snapshot is already installed, so a
 * woken reader sees the new state. Ops are only matched, never applied or
 * retained past a parked reader's run.
 */
function invalidate(state: SourceState, patch: Patch): void {
  if (patch.length === 0) return
  const segsList = patch.map((op) => parsePath(op[1]))
  // O(watchers) scan; an inverted path index would make it O(affected) —
  // headroom, not needed at documented scales (reconcile.perf budget)
  for (const gate of state.gates.values()) {
    // reader mid-run: its read-set is not sealed yet, so park the ops for finalizeGates to judge
    if (gate.recorder !== null) for (const op of patch) gate.deferred.push(op)
    // recorder === null ⇒ paths !== null (finalizeGates runs in every reader's finally)
    else if (gate.paths === null || affects(gate.paths, patch, segsList)) wakeGate(gate)
  }
}

// ---------- gates ----------

/** The gate for a reader's first tracked read of a source, counted if that reader is watched. */
function openGate(state: SourceState, reader: ReactiveNode): Gate {
  const node: SignalNode<number> = {
    currentValue: 0,
    pendingValue: 0,
    deps: undefined,
    depsTail: undefined,
    subs: undefined,
    subsTail: undefined,
    flags: MUTABLE,
  }
  const gate: Gate = { node, source: state, reader, paths: null, recorder: null, counted: false, deferred: [] }
  node.gate = gate
  state.gates.set(reader, gate)
  count(gate, isWatched(reader))
  return gate
}

function wakeGate(gate: Gate): void {
  const node = gate.node
  node.pendingValue = node.pendingValue + 1
  node.flags = MUTABLE | DIRTY
  const subs = node.subs
  if (subs !== undefined) {
    propagate(subs, runDepth !== 0)
    schedule(run)
  }
}

function finalizeGates(mark: number): void {
  while (openGates.length > mark) {
    const gate = openGates.pop()!
    gate.paths = gate.recorder!.finalize()
    gate.recorder = null
    const ops = gate.deferred
    if (ops.length !== 0) {
      gate.deferred = []
      // callers clear RECURSED_CHECK before finalizing, so this wake notifies normally
      if (affects(gate.paths, ops)) wakeGate(gate)
    }
  }
}

/** unlink, then settle a computed dep that may have lost its last watched subscriber (one that lost every subscriber already dropped its deps in `unwatched`). */
function unlinkDep(l: Link, sub: ReactiveNode): Link | undefined {
  const dep = l.dep
  const next = unlink(l, sub)
  if ('getter' in dep && !isWatched(dep)) rewatch(dep, false)
  return next
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
    seen: 0,
    swept: 0,
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
  const h = handed
  try {
    ++cycle
    const oldValue = c.value
    return !Object.is(oldValue, (c.value = settle(c.getter(oldValue), h)))
  } finally {
    activeSub = prevSub
    c.flags &= ~RECURSED_CHECK
    finalizeGates(mark)
    purgeDeps(c)
  }
}

/**
 * A getter's result, free of read proxies: walked if the run was handed any;
 * otherwise only checked for being a proxy itself (one captured in an earlier
 * run and returned whole), which costs a lookup, not a walk.
 */
const settle = <T>(v: T, h: number): T => (handed !== h ? unwrap(v) : unproxy(v))

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
    const h = handed
    try {
      c.value = settle(c.getter(), h)
    } finally {
      activeSub = prevSub
      c.flags &= ~RECURSED_CHECK
      finalizeGates(mark)
    }
  }
  const sub = activeSub
  if (sub !== undefined) {
    const cold = !isWatched(c)
    link(c, sub, cycle)
    if (cold && isWatched(sub)) rewatch(c, true)
  }
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
  const e = start(fn)
  return () => disposeEffect(e)
}

function start(fn: () => void | (() => void)): EffectNode {
  const e: EffectNode = {
    fn,
    cleanup: undefined,
    deps: undefined,
    depsTail: undefined,
    subs: undefined,
    subsTail: undefined,
    flags: WATCHING | RECURSED_CHECK,
  }
  const parent = activeSub
  if (parent !== undefined) {
    link(e, parent, 0)
    parent.flags |= HAS_CHILD_EFFECT
  }
  try {
    runBody(e)
  } catch (error) {
    disposeEffect(e)
    throw error
  }
  requeueIfDirtied(e)
  return e
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
    ++cycle
    try {
      runBody(e)
    } finally {
      purgeDeps(e)
    }
    requeueIfDirtied(e)
  } else if (e.deps !== undefined) {
    e.flags = WATCHING | (flags & HAS_CHILD_EFFECT)
  }
}

/** The body as the active reader, its gates finalized even when it throws. */
function runBody(e: EffectNode): void {
  const prevSub = activeSub
  activeSub = e
  const mark = openGates.length
  try {
    ++runDepth
    const cleanup = e.fn()
    e.cleanup = typeof cleanup === 'function' ? cleanup : undefined
  } finally {
    --runDepth
    activeSub = prevSub
    e.flags &= ~RECURSED_CHECK
    finalizeGates(mark)
  }
}

/** An inner publish reaching a running effect through a computed sets PENDING without queueing (RECURSED_CHECK was up) — catch it once the run is over. */
function requeueIfDirtied(e: EffectNode): void {
  const flags = e.flags
  // WATCHING absent ⇒ disposed, or already queued by a finalizeGates wake
  if (flags & WATCHING && flags & (DIRTY | PENDING)) {
    enqueue(e)
    schedule(run)
  }
}

function runCleanup(e: EffectNode): void {
  const cleanup = e.cleanup as () => void
  e.cleanup = undefined
  untracked(cleanup)
}

// ---------- bindings (effects with a replaceable body) ----------

declare const bindingBrand: unique symbol
/** An effect whose body can be swapped in place. Opaque: only rebind / unbind take it. */
export type Binding = { readonly [bindingBrand]: true }

/** effect(fn), keeping the node so a sink can later swap its body instead of recreating it. */
export const binding = (fn: () => void | (() => void)): Binding => start(fn) as unknown as Binding

/**
 * Replace a binding's body and run it once now, on the same node: its links
 * are re-tracked in place (reads the new body repeats keep their gates) rather
 * than torn down and rebuilt. Called mid-run by its own body, the new body
 * runs on the next flush instead, not synchronously. A disposed binding
 * ignores it.
 */
export function rebind(b: Binding, fn: () => void | (() => void)): void {
  const e = b as unknown as EffectNode
  if (e.flags === 0) return
  e.fn = fn
  e.flags |= DIRTY
  // mid-run: requeueIfDirtied picks up the DIRTY bit when the run ends
  if (!(e.flags & RECURSED_CHECK)) run(e)
}

export const unbind = (b: Binding): void => disposeEffect(b as unknown as EffectNode)

// ---------- disposal ----------

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
    unlinkDep(l, sub)
    l = prev
  }
}

/** Remove deps not re-read during the run that just ended. */
function purgeDeps(sub: ReactiveNode): void {
  const depsTail = sub.depsTail
  let dep = depsTail !== undefined ? depsTail.nextDep : sub.deps
  while (dep !== undefined) {
    dep = unlinkDep(dep, sub)
  }
}

// ---------- scheduling ----------

/** Drain pending effect notifications now. Publishes otherwise batch to one flush per microtask. */
export const flush = (): void => drain(run)

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
