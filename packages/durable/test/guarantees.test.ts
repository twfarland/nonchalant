// The edges of the durable contract: a message that never succeeds, two hosts
// on one key, a snapshot written by older code, the keys handed to the outside
// world, and time.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { spawn } from '@nonchalant/core'
import type { Cast, Json } from '@nonchalant/core'
import { durable, memoryStore, Fenced, type DeadLetter, type DurableProc } from '../src/index.ts'
import { settle } from './rig.ts'

type Msg = Cast<{ type: 'add'; n: number }>
type Sum = { total: number }

/** Adds `n`, and throws on a negative one — the malformed message. */
const adder: DurableProc<Sum, Msg, void> = async function* (self, _args, d) {
  let s: Sum = d.restored ?? { total: 0 }
  yield s
  for await (const msg of self) {
    switch (msg.type) {
      case 'add':
        if (msg.n < 0) throw new Error(`cannot add ${msg.n}`)
        s = { total: s.total + msg.n }
        break
    }
    yield s
  }
}

// ---------- poison messages ----------

describe('a message that keeps crashing the process', () => {
  it('is dead-lettered after maxAttempts and the key moves past it', async () => {
    const store = memoryStore()
    const poisoned: [string, DeadLetter][] = []
    const opts = { store, key: (): string => 'sum', maxAttempts: 3, onPoison: (key: string, dead: DeadLetter) => void poisoned.push([key, dead]) }

    const p = spawn(durable(adder, opts), undefined, { restart: 'on-crash', maxRestarts: 5 })
    p.cast({ type: 'add', n: 2 })
    p.cast({ type: 'add', n: -1 })
    p.cast({ type: 'add', n: 5 })
    await settle(200)

    expect(p()).toStrictEqual({ total: 7 }) // the good messages on either side both landed
    expect(p.error).toBeUndefined()
    expect(store.dead('sum')).toStrictEqual([{ seq: 2, msg: { type: 'add', n: -1 }, error: 'Error: cannot add -1' }])
    expect(poisoned).toStrictEqual([['sum', { seq: 2, msg: { type: 'add', n: -1 }, error: 'Error: cannot add -1' }]])
    p[Symbol.dispose]()
  })

  it('counts attempts across activations, not just restarts', async () => {
    const store = memoryStore()
    const opts = { store, key: (): string => 'sum2', maxAttempts: 2 }

    const first = spawn(durable(adder, opts), undefined)
    first.cast({ type: 'add', n: -3 })
    await settle()
    expect(String(first.error)).toBe('Error: cannot add -3')
    first[Symbol.dispose]()
    expect(store.dead('sum2')).toStrictEqual([])

    const second = spawn(durable(adder, opts), undefined)
    await settle()
    expect(String(second.error)).toBe('Error: cannot add -3') // the second attempt still fails
    second[Symbol.dispose]()
    expect(store.dead('sum2')).toHaveLength(1)

    const third = spawn(durable(adder, opts), undefined)
    third.cast({ type: 'add', n: 4 })
    await settle()
    expect(third()).toStrictEqual({ total: 4 })
    expect(third.error).toBeUndefined()
    third[Symbol.dispose]()
  })

  it('without maxAttempts, is retried on every activation', async () => {
    const store = memoryStore()
    const opts = { store, key: (): string => 'sum3' }
    for (let i = 0; i < 3; i++) {
      const p = spawn(durable(adder, opts), undefined)
      if (i === 0) p.cast({ type: 'add', n: -1 })
      await settle()
      expect(String(p.error)).toBe('Error: cannot add -1')
      p[Symbol.dispose]()
    }
    expect(store.dead('sum3')).toStrictEqual([])
    expect(await store.steps('sum3', 1)).toStrictEqual([]) // and no attempt bookkeeping is written
  })

  it('a store failure is not the message’s fault and does not count as an attempt', async () => {
    const store = memoryStore()
    let refuse = true
    const flaky = { ...store, commit: async (...a: Parameters<typeof store.commit>) => {
      if (refuse) throw new Error('disk full')
      return store.commit(...a)
    } }
    const opts = { store: flaky, key: (): string => 'sum4', maxAttempts: 1 }

    const p = spawn(durable(adder, opts), undefined)
    p.cast({ type: 'add', n: 1 })
    p.cast({ type: 'add', n: 1 })
    await settle()
    expect(String(p.error)).toBe('Error: disk full')
    p[Symbol.dispose]()

    refuse = false
    const back = spawn(durable(adder, opts), undefined)
    await settle()
    expect(back()).toStrictEqual({ total: 2 })
    expect(store.dead('sum4')).toStrictEqual([])
    back[Symbol.dispose]()
  })
})

// ---------- fencing ----------

describe('two activations of one key', () => {
  it('the later one wins: the earlier stops at its next write and changes nothing', async () => {
    const store = memoryStore()
    const opts = { store, key: (): string => 'shared' }

    const older = spawn(durable(adder, opts), undefined)
    older.cast({ type: 'add', n: 1 })
    await settle()

    const newer = spawn(durable(adder, opts), undefined) // its load claims the key
    await settle()
    older.cast({ type: 'add', n: 100 })
    newer.cast({ type: 'add', n: 10 })
    await settle()

    expect(older.error).toBeUndefined() // superseded is not a crash: it just stops
    expect(older()).toStrictEqual({ total: 1 })
    expect(newer()).toStrictEqual({ total: 11 })
    expect((await store.pending('shared', 0)).map((l) => l.msg)).toStrictEqual([])
    newer[Symbol.dispose]()

    const after = spawn(durable(adder, opts), undefined)
    await settle()
    expect(after()).toStrictEqual({ total: 11 }) // the older host's message never reached the log
    after[Symbol.dispose]()
    older[Symbol.dispose]()
  })

  it('the memory store refuses a stale epoch with Fenced', async () => {
    const store = memoryStore()
    const { epoch } = await store.load('k')
    await store.load('k')
    await expect(store.append('k', epoch, 1)).rejects.toBeInstanceOf(Fenced)
    await expect(store.putStep('k', epoch, 1, 0, 'x', 1)).rejects.toBeInstanceOf(Fenced)
    await expect(store.commit('k', epoch, { snapshot: 1, version: 0, cursor: 1, results: [] })).rejects.toBeInstanceOf(Fenced)
    expect(await store.load('k')).toStrictEqual({ snapshot: undefined, version: 0, cursor: 0, epoch: 3 })
  })
})

// ---------- snapshot versions ----------

describe('a snapshot committed by older code', () => {
  type V1 = { count: number }
  const counter: DurableProc<V1, Msg, void> = async function* (self, _args, d) {
    let s = d.restored ?? { count: 0 }
    yield s
    for await (const msg of self) {
      switch (msg.type) {
        case 'add':
          s = { count: s.count + msg.n }
          break
      }
      yield s
    }
  }

  it('is migrated on load and committed under the new version', async () => {
    const store = memoryStore()
    const old = spawn(durable(adder, { store, key: (): string => 'c' }), undefined)
    old.cast({ type: 'add', n: 3 })
    await settle()
    old[Symbol.dispose]()

    const froms: number[] = []
    const migrate = (was: Json, from: number): V1 => {
      froms.push(from)
      return { count: (was as Sum).total }
    }
    const next = spawn(durable(counter, { store, key: (): string => 'c', version: 1, migrate }), undefined)
    await settle()
    expect(next()).toStrictEqual({ count: 3 })
    next.cast({ type: 'add', n: 1 })
    await settle()
    next[Symbol.dispose]()

    expect(froms).toStrictEqual([0])
    expect(await store.load('c')).toMatchObject({ snapshot: { count: 4 }, version: 1 })
  })

  it('without a migrate, refuses to start rather than misread it', async () => {
    const store = memoryStore()
    const old = spawn(durable(adder, { store, key: (): string => 'c2' }), undefined)
    old.cast({ type: 'add', n: 3 })
    await settle()
    old[Symbol.dispose]()

    const next = spawn(durable(counter, { store, key: (): string => 'c2', version: 1 }), undefined)
    await settle()
    expect(String(next.error)).toBe("Error: nonchalant/durable: no migrate for 'c2' from version 0 to 1")
    next[Symbol.dispose]()
  })
})

// ---------- idempotency keys ----------

describe('step idempotency keys', () => {
  it('are stable across a replay and distinct per step', async () => {
    const store = memoryStore()
    const seen: string[] = []
    const charging: DurableProc<Sum, Msg, void> = async function* (self, _args, d) {
      yield { total: 0 }
      for await (const _msg of self) {
        await d.step('reserve', (key) => (seen.push(key), 1))
        await d.step('charge', (key) => {
          seen.push(key)
          throw new Error('gateway timeout') // dies with 'reserve' journaled
        })
      }
    }
    const first = spawn(durable(charging, { store, key: (): string => 'pay' }), undefined)
    first.cast({ type: 'add', n: 1 })
    await settle()
    first[Symbol.dispose]()
    const second = spawn(durable(charging, { store, key: (): string => 'pay' }), undefined)
    await settle()
    second[Symbol.dispose]()

    expect(seen).toStrictEqual(['pay#1#0', 'pay#1#1', 'pay#1#1']) // the retried charge carries the same key
  })
})

// ---------- time ----------

describe('sleep', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  type Nap = { woke: number }
  const napper: DurableProc<Nap, Msg, void> = async function* (self, _args, d) {
    let s = d.restored ?? { woke: 0 }
    yield s
    for await (const _msg of self) {
      await d.sleep('nap', 1000)
      s = { woke: s.woke + 1 }
      yield s
    }
  }

  it('waits out only the remainder after a restart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const store = memoryStore()
    let clock = 0
    const opts = { store, key: (): string => 'nap', now: (): number => clock }

    const first = spawn(durable(napper, opts), undefined)
    first.cast({ type: 'add', n: 1 })
    await settle()
    clock = 400
    vi.advanceTimersByTime(400)
    first[Symbol.dispose]() // the machine goes away 400ms into a 1000ms sleep
    await settle()
    expect(vi.getTimerCount()).toBe(0) // disposal cleared the pending timer

    const second = spawn(durable(napper, opts), undefined)
    await settle()
    vi.advanceTimersByTime(599)
    await settle()
    expect(second()).toStrictEqual({ woke: 0 })
    vi.advanceTimersByTime(1)
    await settle()
    expect(second()).toStrictEqual({ woke: 1 })
    second[Symbol.dispose]()
  })

  it('does not wait at all once the deadline has passed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const store = memoryStore()
    let clock = 0
    const opts = { store, key: (): string => 'nap2', now: (): number => clock }

    const first = spawn(durable(napper, opts), undefined)
    first.cast({ type: 'add', n: 1 })
    await settle()
    first[Symbol.dispose]()

    clock = 5000
    const second = spawn(durable(napper, opts), undefined)
    await settle()
    expect(second()).toStrictEqual({ woke: 1 })
    expect(vi.getTimerCount()).toBe(0)
    second[Symbol.dispose]()
  })

  it('leaves no abort listener behind when the timer wins', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const added = vi.spyOn(AbortSignal.prototype, 'addEventListener')
    const removed = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
    const store = memoryStore()
    let clock = 0
    const p = spawn(durable(napper, { store, key: (): string => 'nap3', now: (): number => clock }), undefined)
    await settle()
    const baseline = added.mock.calls.length

    for (let i = 0; i < 3; i++) {
      p.cast({ type: 'add', n: 1 })
      await settle()
      clock += 1000
      vi.advanceTimersByTime(1000)
      await settle()
    }

    expect(p()).toStrictEqual({ woke: 3 })
    expect(added.mock.calls.length - baseline).toBe(3)
    expect(removed.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(3)
    p[Symbol.dispose]()
  })
})

// ---------- the inbox and the store's extras ----------

describe('latest() on a durable mailbox', () => {
  it('skips to the newest queued message and acknowledges the ones it passed', async () => {
    const store = memoryStore()
    const seen: number[] = []
    const newest: DurableProc<Sum, Msg, void> = async function* (self, _args, d) {
      let s = d.restored ?? { total: 0 }
      yield s
      for await (const msg of self.latest()) {
        seen.push(msg.n)
        s = { total: s.total + msg.n }
        yield s
        await d.step('slow', () => new Promise<number>((resolve) => setImmediate(() => resolve(0))))
      }
    }
    const p = spawn(durable(newest, { store, key: (): string => 'l' }), undefined)
    await settle()
    p.cast({ type: 'add', n: 1 }) // taken at once; the rest queue up behind its slow step
    p.cast({ type: 'add', n: 2 })
    p.cast({ type: 'add', n: 3 })
    p.cast({ type: 'add', n: 4 })
    await settle()

    expect(seen).toStrictEqual([1, 4])
    expect(p()).toStrictEqual({ total: 5 })
    expect(await store.load('l')).toMatchObject({ cursor: 4, snapshot: { total: 5 } })
    expect(await store.pending('l', 0)).toStrictEqual([])
    p[Symbol.dispose]()
  })
})

describe('memoryStore', () => {
  it('counts the keys it holds', async () => {
    const store = memoryStore()
    expect(store.keys()).toBe(0)
    await store.load('a')
    await store.load('b')
    await store.load('a')
    expect(store.keys()).toBe(2)
  })

  it('forgets answers older than the retention window', async () => {
    let clock = 0
    const store = memoryStore(() => clock)
    const { epoch } = await store.load('k')
    await store.commit('k', epoch, { snapshot: null, version: 0, cursor: 0, results: [['old', 1]] })
    clock = 100
    await store.commit('k', epoch, { snapshot: null, version: 0, cursor: 0, results: [['new', 2]] })
    store.prune(50)
    expect(await store.result('k', 'old')).toBeUndefined()
    expect(await store.result('k', 'new')).toBe(2)
  })
})
