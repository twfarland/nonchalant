// The recording as data, and the pure functions over it: fold an event in,
// clear it, and read a process's state at any retained point.
//
// Time travel needs no snapshots: a process's state at seq t is its base
// (the spawn state) with every yield patch up to t applied. When the ring
// drops a yield, its patch folds into the base first (ring.ts), so what is
// retained always reconstructs.

import { applyPatch } from '@nonchalant/core'
import type { Json, Patch } from '@nonchalant/core'
import { trim } from './ring.ts'

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

// ---------- the reducer ----------

const withNode = (rec: Recording, id: number, patch: Partial<ProcNode>): Recording => {
  const node = rec.procs[id]
  return node === undefined ? rec : { ...rec, procs: { ...rec.procs, [id]: { ...node, ...patch } } }
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
      if (node !== undefined) next = withNode(next, d.id, { state: applyPatch(node.state, d.ops) })
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

// ---------- time travel ----------

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
    if (e.type === 'yield' && e.id === id && e.seq > node.baseSeq) state = applyPatch(state, e.ops)
  }
  return state
}
