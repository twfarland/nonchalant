// The reference adapter against the contract every adapter certifies with,
// and the contract against adapters that are wrong on purpose: a suite that
// cannot fail them would certify nothing.

import { describe, it, expect } from 'vitest'
import assert from 'node:assert/strict'
import { memoryStore } from '../src/index.ts'
import { storeConformance } from '../src/conformance.ts'
import { dueKeys } from '../src/memory-store.ts'
import type { ConformanceStore } from '../src/conformance.ts'

storeConformance((now) => memoryStore(now), { describe, it, expect })

// ---------- negative controls ----------

/** Run the whole suite against one adapter, outside the runner; resolves with the names of the tests it fails. */
const failures = async (make: (now: () => number) => ConformanceStore): Promise<string[]> => {
  const tests: [string, () => Promise<void>][] = []
  const path: string[] = []
  storeConformance(make, {
    describe: (name, body) => {
      path.push(name)
      body()
      path.pop()
    },
    it: (name, body) => void tests.push([[...path, name].join(' > '), body]),
    expect: (actual) => ({
      toBe: (expected) => assert.ok(Object.is(actual, expected)),
      toStrictEqual: (expected) => assert.deepStrictEqual(actual, expected),
    }),
  })
  const failed: string[] = []
  for (const [name, body] of tests) await body().catch(() => failed.push(name))
  return failed
}

type Flaw = 'due reads, awaits, then leases' | 'load clears the wake time'

/**
 * The reference adapter with its wake times moved to a table of its own, so
 * one rule about them can be broken on purpose. The racy `due` is the
 * SELECT-then-UPDATE an adapter writes without a transaction.
 */
const flawed = (flaw: Flaw) => (now: () => number): ConformanceStore => {
  const inner = memoryStore(now)
  const wakes = new Map<string, number>()
  return {
    ...inner,
    load: async (key) => {
      const loaded = await inner.load(key)
      if (flaw === 'load clears the wake time') wakes.delete(key)
      return loaded
    },
    append: async (key, epoch, msg, callId, wakeAt) => {
      const seq = await inner.append(key, epoch, msg, callId, wakeAt)
      if (wakeAt !== undefined && !wakes.has(key)) wakes.set(key, wakeAt)
      return seq
    },
    putStep: async (key, epoch, seq, index, name, result, wakeAt) => {
      await inner.putStep(key, epoch, seq, index, name, result, wakeAt)
      if (wakeAt !== undefined) wakes.set(key, wakeAt)
    },
    commit: async (key, epoch, c) => {
      await inner.commit(key, epoch, c)
      const left = (await inner.pending(key, c.cursor)).length > 0
      if (left && c.wakeAt !== undefined) wakes.set(key, c.wakeAt)
      else wakes.delete(key)
    },
    due: async (at, until, limit) => {
      const keys = dueKeys(wakes, at, limit)
      if (flaw === 'due reads, awaits, then leases') await undefined
      for (const key of keys) wakes.set(key, until)
      return keys
    },
  }
}

describe('the conformance suite', () => {
  it('passes the reference adapter when run outside the runner', async () => {
    expect(await failures((now) => memoryStore(now))).toStrictEqual([])
  })

  it('fails an adapter whose due reads and leases in two steps, on the overlapping-callers test alone', async () => {
    expect(await failures(flawed('due reads, awaits, then leases'))).toStrictEqual([
      'Store conformance > wake times and due > hands a due key to only one of two overlapping callers, wherever the second starts',
    ])
  })

  it('fails an adapter that clears the wake time on load, on the load-leaves-wake test alone', async () => {
    expect(await failures(flawed('load clears the wake time'))).toStrictEqual([
      'Store conformance > load > leaves the wake time alone: a key loaded and never committed is still due',
    ])
  })
})
