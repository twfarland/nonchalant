// The in-memory adapters. They are the reference implementations — small
// enough to read in one sitting, exact enough to test against — and they take
// their clock as an argument, which is what lets a lease expire in a test
// without anybody waiting.

import type { Json } from '@nonchalant/core'
import type { Bus, Job, Queue, QueueStats } from './ports.ts'

export function memoryBus(): Bus & { topics(): string[] } {
  const listeners = new Map<string, Set<(event: Json) => void>>()

  return {
    publish: async (topic, event) => {
      // copy first: a handler that unsubscribes mid-publish must not disturb the rest
      for (const listener of [...(listeners.get(topic) ?? [])]) listener(event)
    },
    subscribe: (topic, onEvent) => {
      const set = listeners.get(topic) ?? new Set()
      set.add(onEvent)
      listeners.set(topic, set)
      return () => {
        set.delete(onEvent)
        if (set.size === 0) listeners.delete(topic)
      }
    },
    topics: () => [...listeners.keys()],
  }
}

interface Entry {
  id: string
  body: Json
  attempts: number
  /** Invisible to `reserve` until this moment. */
  visibleAt: number
}

export interface MemoryQueueOpts {
  /** Injected so a test can move time instead of waiting for it. Default `Date.now`. */
  now?: () => number
}

export function memoryQueue(opts: MemoryQueueOpts = {}): Queue & { pending(): number } {
  const now = opts.now ?? Date.now
  const entries: Entry[] = []
  let issued = 0
  let done = 0

  return {
    push: async (body) => {
      const id = `job-${++issued}`
      entries.push({ id, body, attempts: 0, visibleAt: 0 })
      return id
    },

    reserve: async (leaseMs): Promise<Job | undefined> => {
      const at = now()
      const entry = entries.find((e) => e.visibleAt <= at)
      if (entry === undefined) return undefined
      entry.attempts++
      entry.visibleAt = at + leaseMs // hidden until the lease runs out
      return { id: entry.id, body: entry.body, attempts: entry.attempts }
    },

    ack: async (id) => {
      const i = entries.findIndex((e) => e.id === id)
      if (i === -1) return // already acknowledged, or its lease was taken over
      entries.splice(i, 1)
      done++
    },

    release: async (id) => {
      const entry = entries.find((e) => e.id === id)
      if (entry !== undefined) entry.visibleAt = 0
    },

    stats: async (): Promise<QueueStats> => {
      const at = now()
      return {
        waiting: entries.filter((e) => e.visibleAt <= at).length,
        leased: entries.filter((e) => e.visibleAt > at).length,
        done,
      }
    },

    pending: () => entries.length,
  }
}
