// Shared by the durable tests: a turn of the event loop, and a store that dies
// on schedule.

import type { Store } from '../src/index.ts'

// setImmediate, not setTimeout: on Windows a 0ms timer costs ~15ms, which
// turns a settle loop into a test that looks like a hang
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
export const settle = async (turns = 40): Promise<void> => {
  for (let i = 0; i < turns; i++) await tick()
}

/**
 * A store that dies after `budget` operations — a crash at an arbitrary point,
 * deterministically placed. `slow` makes every operation take a turn of the
 * event loop, so writes that are not awaited get overtaken.
 */
export const failAfter = (store: Store, budget: number, slow = false): Store => {
  let used = 0
  const guard = async (): Promise<void> => {
    if (slow) await tick()
    if (used++ >= budget) throw new Error('CRASH')
  }
  return {
    load: async (k) => (await guard(), store.load(k)),
    append: async (k, e, m, c) => (await guard(), store.append(k, e, m, c)),
    pending: async (k, c) => (await guard(), store.pending(k, c)),
    putStep: async (k, e, s, i, n, r) => (await guard(), store.putStep(k, e, s, i, n, r)),
    steps: async (k, s) => (await guard(), store.steps(k, s)),
    commit: async (k, e, c) => (await guard(), store.commit(k, e, c)),
    result: async (k, c) => (await guard(), store.result(k, c)),
  }
}
