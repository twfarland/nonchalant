// The recorder: core's instrument events, made plain data (summarize.ts) and
// folded into a bounded recording (recording.ts, ring.ts), owned by one
// process. Everything but `inspect` and the recorder is a pure function over
// `Recording`, testable without a runtime.

import { derive, instrument, spawn, untracked } from '@nonchalant/core'
import type { Cast, Json, Process, Self } from '@nonchalant/core'
import { clear, empty, record, stateAt } from './recording.ts'
import type { Draft, Entry, Recording } from './recording.ts'
import { draft } from './summarize.ts'
import { tree } from './tree.ts'
import type { TreeNode } from './tree.ts'

export { clear, empty, record, stateAt } from './recording.ts'
export type { Draft, Entry, ProcNode, Recording } from './recording.ts'
export { draft, summarize } from './summarize.ts'
export { tree } from './tree.ts'
export type { TreeNode } from './tree.ts'

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
