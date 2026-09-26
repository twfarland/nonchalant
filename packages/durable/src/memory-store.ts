// The reference adapter: everything in one Map. It loses its contents with the
// process and keeps the semantics exactly, which is what makes it the test rig
// — the crash-consistency property runs against this.

import type { Json } from '@nonchalant/core'
import { Fenced } from './store.ts'
import type { DeadLetter, Loaded, Logged, StepRecord, Store } from './store.ts'

interface Entry {
  snapshot: Json | undefined
  version: number
  cursor: number
  epoch: number
  next: number
  log: Logged[]
  steps: Map<number, StepRecord[]>
  results: Map<string, readonly [answer: Json, at: number]>
  dead: DeadLetter[]
  wake: number | undefined
}

export interface MemoryStore extends Store {
  /** How many keys this store holds — for tests that assert reclamation. */
  keys(): number
  /** The messages this key gave up on, oldest first. */
  dead(key: string): DeadLetter[]
  /** Forget answers committed before `before` (by this store's clock): the retention window a real adapter runs as a TTL. */
  prune(before: number): void
}

// ---------- pure helpers ----------

/** Up to `limit` keys whose wake time is at or before `at`, earliest first; ties keep their given order. */
export const dueKeys = (wakes: Iterable<readonly [key: string, wake: number | undefined]>, at: number, limit: number): string[] =>
  [...wakes].filter((w): w is [string, number] => w[1] !== undefined && w[1] <= at)
    .sort(([, a], [, b]) => a - b)
    .slice(0, limit)
    .map(([key]) => key)

/** The answers committed at or after `before`: what the retention window keeps. */
export const retained = <A>(results: ReadonlyMap<string, readonly [answer: A, at: number]>, before: number): Map<string, readonly [answer: A, at: number]> =>
  new Map([...results].filter(([, [, at]]) => at >= before))

// ---------- the store ----------

export function memoryStore(now: () => number = Date.now): MemoryStore {
  const keys = new Map<string, Entry>()
  const entry = (key: string): Entry => {
    let e = keys.get(key)
    if (e === undefined) {
      e = { snapshot: undefined, version: 0, cursor: 0, epoch: 0, next: 1, log: [], steps: new Map(), results: new Map(), dead: [], wake: undefined }
      keys.set(key, e)
    }
    return e
  }
  const owned = (key: string, epoch: number): Entry => {
    const e = entry(key)
    if (epoch !== e.epoch) throw new Fenced(key)
    return e
  }

  return {
    load: async (key): Promise<Loaded> => {
      const e = entry(key)
      return { snapshot: e.snapshot, version: e.version, cursor: e.cursor, epoch: ++e.epoch }
    },
    append: async (key, epoch, msg, callId) => {
      const e = owned(key, epoch)
      const seq = e.next++
      e.log.push(callId === undefined ? { seq, msg } : { seq, msg, callId })
      return seq
    },
    pending: async (key, cursor) => entry(key).log.filter((l) => l.seq > cursor),
    putStep: async (key, epoch, seq, index, name, result, wakeAt) => {
      const e = owned(key, epoch)
      e.steps.set(seq, [...(e.steps.get(seq) ?? []), { index, name, result }])
      if (wakeAt !== undefined) e.wake = wakeAt
    },
    steps: async (key, seq) => [...(entry(key).steps.get(seq) ?? [])],
    commit: async (key, epoch, c) => {
      const e = owned(key, epoch)
      e.snapshot = c.snapshot
      e.version = c.version
      e.cursor = c.cursor
      e.wake = undefined
      for (const [callId, answer] of c.results) e.results.set(callId, [answer, now()])
      if (c.dead !== undefined) e.dead.push(c.dead)
      e.log = e.log.filter((l) => l.seq > c.cursor)
      for (const seq of [...e.steps.keys()]) if (seq <= c.cursor) e.steps.delete(seq)
    },
    result: async (key, callId) => entry(key).results.get(callId)?.[0],
    // selection and lease in one synchronous turn: nothing can interleave between them
    due: async (at, until, limit) => {
      const ready = dueKeys([...keys].map(([key, e]) => [key, e.wake] as const), at, limit)
      for (const key of ready) entry(key).wake = until
      return ready
    },
    keys: () => keys.size,
    dead: (key) => [...entry(key).dead],
    prune: (before) => {
      for (const e of keys.values()) e.results = retained(e.results, before)
    },
  }
}
