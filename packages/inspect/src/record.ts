// The recording: core's instrument events, made plain data and kept in a
// bounded ring, owned by one process. Everything here but `inspect` is a pure
// function over `Recording`, testable without a runtime.
//
// Time travel needs no snapshots: a process's state at seq t is its base
// (the spawn state) with every yield patch up to t applied. When the ring
// drops a yield, its patch folds into the base first, so what is retained
// always reconstructs.

import { applyPatch, derive, instrument, spawn, untracked } from '@nonchalant/core'
import type { Cast, Json, Patch, Process, ProcessEvent, Self } from '@nonchalant/core'

// ---------- state ----------

type Status = 'running' | 'done' | 'crashed' | 'disposed'

/** A core event with every live value summarized to JSON (no seq yet). */
export type Draft =
  | { type: 'spawn'; id: number; parent: number | null; name: string; key: string | null; args: Json; state: Json | null }
  | { type: 'cast'; id: number; msg: Json }
  | { type: 'call'; id: number; msg: Json; call: number }
  | { type: 'reply'; id: number; call: number; value: Json }
  | { type: 'yield'; id: number; ops: Patch }
  | { type: 'status'; id: number; pending: boolean; stale: boolean; errored: boolean }
  | { type: 'crash'; id: number; error: string }
  | { type: 'restart'; id: number; attempt: number }
  | { type: 'exit'; id: number; reason: Exclude<Status, 'running'> }

/** One timeline row. Status flips update the tree but are not rows. */
export type Entry = Exclude<Draft, { type: 'status' }> & { seq: number }

export interface ProcNode {
  id: number
  parent: number | null
  name: string
  key: string | null
  status: Status
  pending: boolean
  stale: boolean
  errored: boolean
  /** Current state: `base` with every retained yield applied. */
  state: Json | null
  /** State as of `baseSeq`: the spawn state, plus the yields the ring has dropped. */
  base: Json | null
  baseSeq: number
}

export interface Recording {
  size: number
  seq: number
  events: Entry[]
  procs: { [id: string]: ProcNode }
}

export const empty = (size: number): Recording => ({ size, seq: 0, events: [], procs: {} })

// ---------- pure helpers ----------

const tag = (v: object): string => {
  const ctor = (v as { constructor?: { name?: unknown } }).constructor
  return typeof ctor?.name === 'string' && ctor.name !== '' ? ctor.name : 'Object'
}

/**
 * A structuredClone- and JSON-safe stand-in for any value. Plain JSON comes
 * back by reference (so recorded states share structure with the app's);
 * everything else becomes a bracketed label.
 */
export function summarize(value: unknown, depth = 0, seen: Set<object> = new Set()): Json {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'undefined':
      return '[undefined]'
    case 'bigint':
      return `${value}n`
    case 'symbol':
      return `[${String(value)}]`
    case 'function':
      return `[function ${value.name || 'anonymous'}]`
    case 'object':
      break
  }
  if (value === null) return null
  const obj = value as object
  if (value instanceof Error) return `[${value.name}: ${value.message}]`
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString()
  if (seen.has(obj)) return '[cycle]'
  if (depth >= 12) return '[…]'
  seen.add(obj)
  try {
    if (Array.isArray(obj)) {
      let same = true
      const out = obj.map((v: unknown) => {
        const s = summarize(v, depth + 1, seen)
        if (s !== v) same = false
        return s
      })
      return same ? (obj as Json[]) : out
    }
    const proto = Object.getPrototypeOf(obj)
    if (proto !== Object.prototype && proto !== null) return `[${tag(obj)}]`
    let same = true
    const out: { [k: string]: Json } = {}
    for (const [k, v] of Object.entries(obj)) {
      const s = summarize(v, depth + 1, seen)
      if (s !== v) same = false
      out[k] = s
    }
    return same ? (obj as { [k: string]: Json }) : out
  } finally {
    seen.delete(obj)
  }
}

const summarizeOps = (ops: Patch): Patch =>
  ops.map((op): Patch[number] => {
    switch (op[0]) {
      case 'set': return ['set', op[1], summarize(op[2])]
      case 'del': return op
      case 'splice': return ['splice', op[1], op[2], op[3], op[4].map((v) => summarize(v))]
    }
  })

/** A raw core event as plain data. Runs inside the sink, so live values are captured as they were. */
export function draft(e: ProcessEvent): Draft {
  switch (e.type) {
    case 'spawn':
      return {
        type: 'spawn', id: e.id, parent: e.parent, name: e.name, key: e.key ?? null,
        args: summarize(e.args), state: e.state === undefined ? null : summarize(e.state),
      }
    case 'cast': return { type: 'cast', id: e.id, msg: summarize(e.msg) }
    case 'call': return { type: 'call', id: e.id, msg: summarize(e.msg), call: e.call }
    case 'reply': return { type: 'reply', id: e.id, call: e.call, value: summarize(e.value) }
    case 'yield': return { type: 'yield', id: e.id, ops: summarizeOps(e.ops) }
    case 'status': return { type: 'status', id: e.id, pending: e.pending, stale: e.stale, errored: e.errored }
    case 'crash': return { type: 'crash', id: e.id, error: String(summarize(e.error)) }
    case 'restart': return { type: 'restart', id: e.id, attempt: e.attempt }
    case 'exit': return { type: 'exit', id: e.id, reason: e.reason }
  }
}

const apply = (state: Json | null, ops: Patch): Json | null => applyPatch(state, ops)

const withNode = (rec: Recording, id: number, patch: Partial<ProcNode>): Recording => {
  const node = rec.procs[id]
  return node === undefined ? rec : { ...rec, procs: { ...rec.procs, [id]: { ...node, ...patch } } }
}

// the oldest entries leave together, a quarter of the ring at a time, so most
// appends reach the timeline's readers as a single splice
const trim = (rec: Recording): Recording => {
  if (rec.events.length <= rec.size) return rec
  const cut = Math.max(rec.events.length - rec.size, Math.ceil(rec.size / 4))
  let procs = rec.procs
  for (const e of rec.events.slice(0, cut)) {
    const node = procs[e.id]
    if (node === undefined) continue
    if (e.type === 'yield') procs = { ...procs, [e.id]: { ...node, base: apply(node.base, e.ops), baseSeq: e.seq } }
    else if (e.type === 'exit' && node.status !== 'running') {
      const { [e.id]: _gone, ...rest } = procs
      procs = rest
    }
  }
  return { ...rec, events: rec.events.slice(cut), procs }
}

/** The reducer: fold one event into the recording. */
export function record(rec: Recording, d: Draft): Recording {
  if (d.type === 'status') {
    const { type: _t, id, ...flags } = d
    return withNode(rec, id, flags)
  }
  const seq = rec.seq + 1
  let next: Recording = { ...rec, seq, events: [...rec.events, { ...d, seq }] }
  switch (d.type) {
    case 'spawn': {
      const node: ProcNode = {
        id: d.id, parent: d.parent, name: d.name, key: d.key, status: 'running',
        pending: true, stale: false, errored: false, state: d.state, base: d.state, baseSeq: seq,
      }
      next = { ...next, procs: { ...next.procs, [d.id]: node } }
      break
    }
    case 'yield': {
      const node = next.procs[d.id]
      if (node !== undefined) next = withNode(next, d.id, { state: apply(node.state, d.ops) })
      break
    }
    case 'crash':
      next = withNode(next, d.id, { status: 'crashed' })
      break
    case 'restart':
      next = withNode(next, d.id, { status: 'running' })
      break
    case 'exit':
      next = withNode(next, d.id, { status: d.reason })
      break
    case 'cast':
    case 'call':
    case 'reply':
      break
  }
  return trim(next)
}

/** Drop every entry and every ended process; a running process's current state becomes its base. */
export function clear(rec: Recording): Recording {
  const procs: Recording['procs'] = {}
  for (const node of Object.values(rec.procs))
    if (node.status === 'running') procs[node.id] = { ...node, base: node.state, baseSeq: rec.seq }
  return { ...rec, events: [], procs }
}

/**
 * A process's state just after event `seq`: its base with every retained
 * yield up to `seq` applied. Undefined when the process is unknown or `seq`
 * is older than what the ring retains for it.
 */
export function stateAt(rec: Recording, id: number, seq: number): Json | null | undefined {
  const node = rec.procs[id]
  if (node === undefined || seq < node.baseSeq) return undefined
  let state = node.base
  for (const e of rec.events) {
    if (e.seq > seq) break
    if (e.type === 'yield' && e.id === id && e.seq > node.baseSeq) state = apply(state, e.ops)
  }
  return state
}

export interface TreeNode {
  node: ProcNode
  children: TreeNode[]
}

/** Recorded processes not yet disposed, nested by ownership (unknown parents become roots). */
export function tree(procs: Recording['procs']): TreeNode[] {
  const byId = new Map<number, TreeNode>()
  for (const node of Object.values(procs)) if (node.status !== 'disposed') byId.set(node.id, { node, children: [] })
  const roots: TreeNode[] = []
  for (const t of byId.values()) {
    const parent = t.node.parent === null ? undefined : byId.get(t.node.parent)
    if (parent === undefined) roots.push(t)
    else parent.children.push(t)
  }
  return roots
}

// ---------- the recorder process ----------

export type RecorderMsg = Cast<{ type: 'event'; draft: Draft }> | Cast<{ type: 'clear' }>

export async function* recorder(self: Self<RecorderMsg>, size: number): AsyncGenerator<Recording> {
  let rec = empty(size)
  for await (const msg of self) {
    switch (msg.type) {
      case 'event':
        rec = record(rec, msg.draft)
        break
      case 'clear':
        rec = clear(rec)
        break
    }
    yield rec
  }
}

// ---------- inspect ----------

export interface InspectOptions {
  /** Timeline entries kept (default 1000); the oldest quarter drops when full. */
  size?: number
}

export interface Inspector extends Disposable {
  /** The owner of the recording. */
  readonly recording: Process<Recording, RecorderMsg>
  /** Live processes, nested by ownership. */
  readonly tree: Process<TreeNode[]>
  /** The retained events, oldest first. */
  readonly timeline: Process<Entry[]>
  /** A process's state just after event `seq` (time travel). */
  stateAt(id: number, seq: number): Json | null | undefined
  /** Run `fn` with every process it spawns counted as the inspector's own, and so not recorded. */
  adopt<T>(fn: () => T): T
}

/**
 * Start recording every process event. One inspector at a time (core has one
 * sink). The inspector's own processes, and everything they own, are not
 * recorded — otherwise recording an event would be an event.
 */
export function inspect(options?: InspectOptions): Inspector {
  const size = options?.size ?? 1000
  if (!Number.isInteger(size) || size < 1) throw new Error('nonchalant/inspect: size must be a positive integer')
  const own = new Set<number>()
  let adopting = false
  let recording: Process<Recording, RecorderMsg> | undefined

  const remove = instrument((e) => {
    if (e.type === 'spawn' && (adopting || (e.parent !== null && own.has(e.parent)))) own.add(e.id)
    if (!own.has(e.id)) recording?.cast({ type: 'event', draft: draft(e) })
  })

  const adopt = <T>(fn: () => T): T => {
    const prev = adopting
    adopting = true
    try {
      return fn()
    } finally {
      adopting = prev
    }
  }

  const rec = adopt(() => spawn(recorder, size, { initial: empty(size) }))
  recording = rec
  // subscribe to the whole subtree, then hand out the raw snapshot: tree()
  // reads a few fields of each node but returns the nodes themselves, and a
  // traversed read would not wake on the fields it skipped
  const timeline = derive(() => {
    void rec().events
    return untracked(rec).events
  })
  const treeView = derive(() => {
    void rec().procs
    return tree(untracked(rec).procs)
  })

  return {
    recording: rec,
    tree: treeView,
    timeline,
    stateAt: (id, seq) => stateAt(rec(), id, seq),
    adopt,
    [Symbol.dispose]: () => {
      remove()
      timeline[Symbol.dispose]()
      treeView[Symbol.dispose]()
      rec[Symbol.dispose]()
    },
  }
}
