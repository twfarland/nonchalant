// The reference adapter: everything in one Map. It loses its contents with the
// process and keeps the semantics exactly, which is what makes it the test rig
// — the crash-consistency property runs against this.

import type { Json } from '@nonchalant/core'
import type { Loaded, Logged, StepRecord, Store } from './store.ts'

interface Entry {
  snapshot: Json | undefined
  cursor: number
  log: Logged[]
  steps: Map<number, StepRecord[]>
  results: Map<string, Json>
  next: number
}

export interface MemoryStore extends Store {
  /** How many keys this store holds — for tests that assert reclamation. */
  keys(): number
}

export function memoryStore(): MemoryStore {
  const keys = new Map<string, Entry>()
  const entry = (key: string): Entry => {
    let e = keys.get(key)
    if (e === undefined) {
      e = { snapshot: undefined, cursor: 0, log: [], steps: new Map(), results: new Map(), next: 1 }
      keys.set(key, e)
    }
    return e
  }

  return {
    load: async (key): Promise<Loaded | undefined> =>
      keys.has(key) ? { snapshot: entry(key).snapshot, cursor: entry(key).cursor } : undefined,
    append: async (key, msg, callId) => {
      const e = entry(key)
      const seq = e.next++
      e.log.push(callId === undefined ? { seq, msg } : { seq, msg, callId })
      return seq
    },
    pending: async (key, cursor) => entry(key).log.filter((l) => l.seq > cursor),
    putStep: async (key, seq, index, name, result) => {
      const e = entry(key)
      e.steps.set(seq, [...(e.steps.get(seq) ?? []), { index, name, result }])
    },
    steps: async (key, seq) => [...(entry(key).steps.get(seq) ?? [])],
    commit: async (key, snapshot, cursor) => {
      const e = entry(key)
      e.snapshot = snapshot
      e.cursor = cursor
      e.log = e.log.filter((l) => l.seq > cursor)
      for (const seq of [...e.steps.keys()]) if (seq <= cursor) e.steps.delete(seq)
    },
    result: async (key, callId) => entry(key).results.get(callId),
    putResult: async (key, callId, value) => {
      entry(key).results.set(callId, value)
    },
    keys: () => keys.size,
  }
}
