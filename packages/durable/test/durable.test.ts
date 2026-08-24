import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { spawn } from '@nonchalant/core'
import type { Cast } from '@nonchalant/core'
import { durable, memoryStore, type DurableProc, type Store } from '../src/index.ts'

// setImmediate, not setTimeout: on Windows a 0ms timer costs ~15ms, which
// turns a settle loop into a test that looks like a hang
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const settle = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await tick()
}

type Msg = Cast<{ type: 'order'; n: number }>
type State = { done: string[]; total: number }

interface Ledger {
  run<R>(name: string, value: R): R
  count(name: string): number
  total(): number
}

/** Counts what actually executed, so "it did not run again" is an assertion and not a hope. */
const ledger = (): Ledger => {
  const calls = new Map<string, number>()
  return {
    run: (name, value) => {
      calls.set(name, (calls.get(name) ?? 0) + 1)
      return value
    },
    count: (name) => calls.get(name) ?? 0,
    total: () => [...calls.values()].reduce((a, b) => a + b, 0),
  }
}

const workflow = (log: Ledger): DurableProc<State, Msg, { id: string }> =>
  async function* (self, _args, d) {
    let s: State = d.restored ?? { done: [], total: 0 }
    yield s
    for await (const msg of self) {
      const charged = await d.step('charge', () => log.run('charge', msg.n * 2))
      const shipped = await d.step('ship', () => log.run('ship', msg.n + 1))
      s = { done: [...s.done, `charge:${charged}`, `ship:${shipped}`], total: s.total + charged + shipped }
      yield s
    }
  }

/** A store that dies after `budget` operations — a crash at an arbitrary point, deterministically placed. */
const failAfter = (store: Store, budget: number): Store => {
  let used = 0
  const guard = (): void => {
    if (used++ >= budget) throw new Error('CRASH')
  }
  return {
    load: (k) => (guard(), store.load(k)),
    append: (k, m, c) => (guard(), store.append(k, m, c)),
    pending: (k, c) => (guard(), store.pending(k, c)),
    putStep: (k, s, i, n, r) => (guard(), store.putStep(k, s, i, n, r)),
    steps: (k, s) => (guard(), store.steps(k, s)),
    commit: (k, s, c) => (guard(), store.commit(k, s, c)),
    result: (k, c) => (guard(), store.result(k, c)),
    putResult: (k, c, v) => (guard(), store.putResult(k, c, v)),
  }
}

describe('durable', () => {
  it('restores its state and picks up where it stopped', async () => {
    const store = memoryStore()
    const log = ledger()
    const opts = { store, key: (a: { id: string }) => a.id }

    const first = spawn(durable(workflow(log), opts), { id: 'w1' })
    first.cast({ type: 'order', n: 5 })
    await settle()
    expect(first()?.total).toBe(16) // 10 charged + 6 shipped
    first[Symbol.dispose]()

    const second = spawn(durable(workflow(log), opts), { id: 'w1' })
    await settle()
    expect(second()).toStrictEqual({ done: ['charge:10', 'ship:6'], total: 16 })
    expect(log.total()).toBe(2) // the committed message is not handled again
    second[Symbol.dispose]()
  })

  it('an effect completed before the crash is answered from the journal, not re-run', async () => {
    const store = memoryStore()
    const log = ledger()
    const opts = { store, key: (a: { id: string }) => a.id }

    // die during the second effect's journal write: 'charge' is recorded, 'ship' is not
    let writes = 0
    const flaky: Store = {
      ...store,
      putStep: async (k, s, i, n, r) => {
        if (++writes === 2) throw new Error('CRASH')
        return store.putStep(k, s, i, n, r)
      },
    }

    const crashed = spawn(durable(workflow(log), { ...opts, store: flaky }), { id: 'w2' })
    crashed.cast({ type: 'order', n: 3 })
    await settle()
    expect(crashed.error).toBeInstanceOf(Error)
    expect(log.count('charge')).toBe(1)
    expect(log.count('ship')).toBe(1) // it ran, but its result never landed
    crashed[Symbol.dispose]()

    const resumed = spawn(durable(workflow(log), opts), { id: 'w2' })
    await settle()
    expect(resumed()).toStrictEqual({ done: ['charge:6', 'ship:4'], total: 10 })
    expect(log.count('charge')).toBe(1) // journaled: replaced by its recorded result
    expect(log.count('ship')).toBe(2) // not journaled: at-least-once, as promised
    resumed[Symbol.dispose]()
  })

  it('a message the process never finished is redelivered', async () => {
    const store = memoryStore()
    const log = ledger()
    const opts = { store, key: (a: { id: string }) => a.id }

    const p = spawn(durable(workflow(log), opts), { id: 'w3' })
    p.cast({ type: 'order', n: 1 })
    p.cast({ type: 'order', n: 2 })
    await tick() // journaled, not yet handled
    p[Symbol.dispose]()
    await settle()

    const resumed = spawn(durable(workflow(log), opts), { id: 'w3' })
    await settle()
    expect(resumed()?.done).toStrictEqual(['charge:2', 'ship:2', 'charge:4', 'ship:3'])
    resumed[Symbol.dispose]()
  })

  it('a store that will not take a message crashes the process instead of dropping it', async () => {
    const store = memoryStore()
    const refuses: Store = { ...store, append: async () => { throw new Error('disk full') } }
    const p = spawn(durable(workflow(ledger()), { store: refuses, key: (): string => 'w5' }), { id: 'w5' })
    p.cast({ type: 'order', n: 1 })
    await settle()
    expect(String(p.error)).toMatch(/disk full/)
    p[Symbol.dispose]()
  })

  it('a step sequence that drifts on replay is refused, not silently mismatched', async () => {
    const store = memoryStore()
    const opts = { store, key: (): string => 'w4' }

    const before: DurableProc<State, Msg, void> = async function* (self, _a, d) {
      yield { done: [], total: 0 }
      for await (const _msg of self) {
        await d.step('charge', () => 1)
        throw new Error('CRASH') // dies with 'charge' journaled and the message unacked
      }
    }
    const after: DurableProc<State, Msg, void> = async function* (self, _a, d) {
      const s: State = d.restored ?? { done: [], total: 0 }
      yield s
      for await (const _msg of self) {
        await d.step('refund', () => 1) // a different first step for the same message
        yield s
      }
    }

    const a = spawn(durable(before, opts), undefined)
    a.cast({ type: 'order', n: 1 })
    await settle()
    a[Symbol.dispose]()

    const b = spawn(durable(after, opts), undefined)
    await settle()
    expect(String(b.error)).toMatch(/order of steps/)
    b[Symbol.dispose]()
  })
})

describe('durable: crash consistency', () => {
  const key = 'p'

  /** Run a workflow through a schedule of crashes; report where it landed and what executed. */
  const runThrough = async (
    orders: number[],
    schedule: number[],
  ): Promise<{ state: State | undefined; runs: number }> => {
    const store = memoryStore()
    const log = ledger()
    const attempts = [...schedule, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]

    let state: State | undefined
    for (const budget of attempts) {
      const loaded = await store.load(key)
      const cursor = loaded?.cursor ?? 0
      const known = cursor + (await store.pending(key, cursor)).length
      const proc = durable(workflow(log), { store: failAfter(store, budget), key: (): string => key })
      const p = spawn(proc, { id: key })
      for (const n of orders.slice(known)) p.cast({ type: 'order', n }) // the sender retries what was not accepted
      await settle()
      const value = p()
      const failed = p.error !== undefined
      if (!failed && value !== undefined) state = value
      p[Symbol.dispose]()
      await tick()
      if (!failed && ((await store.load(key))?.cursor ?? 0) >= orders.length) break
    }
    return { state, runs: log.total() }
  }

  it('any crash schedule lands on the state the uninterrupted run reaches', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 3 }),
        fc.array(fc.nat(14), { maxLength: 3 }),
        async (orders, schedule) => {
          const clean = await runThrough(orders, [])
          const crashy = await runThrough(orders, schedule)
          expect(crashy.state).toStrictEqual(clean.state)
          // duplicates are bounded by the crashes: an effect re-runs only when
          // its journal write did not land
          expect(crashy.runs).toBeGreaterThanOrEqual(clean.runs)
          expect(crashy.runs).toBeLessThanOrEqual(clean.runs + schedule.length * 2)
        },
      ),
      { numRuns: 30 },
    )
  })
})
