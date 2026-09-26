// Timers that fire with nobody looking: a journaled deadline makes its key
// due, and a scheduler activates due keys through a registry. Time is a fake
// clock and faked timers, advanced together.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { define, registry } from '@nonchalant/core'
import type { Cast } from '@nonchalant/core'
import { durable, memoryStore, scheduler, type DurableProc, type Store } from '../src/index.ts'
import { settle } from './rig.ts'

type Msg = Cast<{ type: 'nap' }>
type Nap = { woke: number }

let clock = 0
let rung: string[] = []
let delivered: string[] = []
let hold: Promise<void> | undefined

/** Sleeps a second per message, then rings (journaled) and delivers (journaled, and held while `hold` is set). */
const napper: DurableProc<Nap, Msg, { id: string }> = async function* (self, args, d) {
  let s = d.restored ?? { woke: 0 }
  yield s
  for await (const msg of self) {
    switch (msg.type) {
      case 'nap':
        await d.sleep('nap', 1000)
        await d.step('ring', () => (rung.push(args.id), 0))
        await d.step('deliver', async (key) => {
          delivered.push(key)
          const wait = hold
          hold = undefined // only the first delivery is held
          await wait
          return 0
        })
        s = { woke: s.woke + 1 }
        break
    }
    yield s
  }
}

/** One host: its own registry over the shared store. */
const host = (store: Store, opts: { maxAttempts?: number } = {}) =>
  registry({ nap: define(durable(napper, { store, key: (a: { id: string }) => a.id, now: () => clock, ...opts })) })

const advance = async (ms: number): Promise<void> => {
  clock += ms
  vi.advanceTimersByTime(ms)
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  clock = 0
  rung = []
  delivered = []
  hold = undefined
})

afterEach(() => {
  vi.useRealTimers()
})

describe('scheduler', () => {
  it('resumes a sleeping process after its deadline with no other lookup', async () => {
    const store = memoryStore(() => clock)
    const reg = host(store)
    reg.lookup('nap', { id: 'n1' }).cast({ type: 'nap' })
    await settle()
    reg.evict('nap') // the instance goes away mid-sleep; only the journal remembers

    const woken: string[] = []
    const sch = scheduler({ store, wake: (id) => (woken.push(id), reg.lookup('nap', { id })), interval: 100, now: () => clock })
    await advance(900)
    expect(rung).toStrictEqual([])
    await advance(100)
    expect(woken).toStrictEqual(['n1'])
    expect(rung).toStrictEqual(['n1'])

    await advance(60_000) // well past any lease: the commit cleared the wake
    expect(woken).toStrictEqual(['n1'])
    expect(await store.load('n1')).toMatchObject({ snapshot: { woke: 1 }, cursor: 1 })
    sch[Symbol.dispose]()
    reg.evict('nap')
  })

  it('catches up on keys that came due while no scheduler was running, earliest first', async () => {
    const store = memoryStore(() => clock)
    const reg = host(store)
    for (const id of ['c', 'a', 'b']) {
      if (id === 'a') clock -= 20 // 'a' fell asleep first, then 'b', then 'c'
      if (id === 'b') clock += 10
      reg.lookup('nap', { id }).cast({ type: 'nap' })
      await settle()
    }
    reg.evict('nap')
    await advance(5000)

    const woken: string[] = []
    const sch = scheduler({ store, wake: (id) => (woken.push(id), reg.lookup('nap', { id })), limit: 2, now: () => clock })
    await settle()
    expect(woken).toStrictEqual(['a', 'b', 'c']) // one pass, two fetches
    expect(rung.sort()).toStrictEqual(['a', 'b', 'c'])
    sch[Symbol.dispose]()
    reg.evict('nap')
  })

  it('stops passing once disposed', async () => {
    const store = memoryStore(() => clock)
    const reg = host(store)
    reg.lookup('nap', { id: 'n1' }).cast({ type: 'nap' })
    await settle()
    reg.evict('nap')

    const woken: string[] = []
    const sch = scheduler({ store, wake: (id) => void woken.push(id), interval: 100, now: () => clock })
    await settle()
    sch[Symbol.dispose]()
    await advance(5000)
    expect(woken).toStrictEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('redelivers a crashed message where no supervisor restarts it, until it is dead-lettered', async () => {
    const store = memoryStore(() => clock)
    let failures = 0
    const bad: DurableProc<Nap, Msg, { id: string }> = async function* (self, _args, d) {
      yield d.restored ?? { woke: 0 }
      for await (const _msg of self) {
        failures++
        throw new Error('boom')
      }
    }
    const reg = registry({ bad: define(durable(bad, { store, key: (a: { id: string }) => a.id, now: () => clock, maxAttempts: 3 })) })
    reg.lookup('bad', { id: 'p' }).cast({ type: 'nap' })
    await settle()
    expect(failures).toBe(1)

    const sch = scheduler({ store, wake: (id) => reg.lookup('bad', { id }), interval: 100, now: () => clock })
    await advance(100)
    await advance(100)
    await advance(1000)
    expect(failures).toBe(3)
    expect(store.dead('p')).toHaveLength(1)
    sch[Symbol.dispose]()
    reg.evict('bad')
  })
})

describe('two schedulers on one store', () => {
  it('wake a due key once between them, and its effects run once', async () => {
    const store = memoryStore(() => clock)
    const hostA = host(store)
    const hostB = host(store)
    hostA.lookup('nap', { id: 'k' }).cast({ type: 'nap' })
    await settle()
    hostA.evict('nap')

    const woken: string[] = []
    const a = scheduler({ store, wake: (id) => (woken.push(`A:${id}`), hostA.lookup('nap', { id })), interval: 100, now: () => clock })
    const b = scheduler({ store, wake: (id) => (woken.push(`B:${id}`), hostB.lookup('nap', { id })), interval: 100, now: () => clock })
    await advance(1000)
    await advance(60_000)

    expect(woken).toHaveLength(1)
    expect(rung).toStrictEqual(['k'])
    expect(delivered).toStrictEqual(['k#1#2'])
    a[Symbol.dispose]()
    b[Symbol.dispose]()
    hostA.evict('nap')
    hostB.evict('nap')
  })

  it('when a lease runs out mid-message, the second activation fences the first and the message commits once', async () => {
    const store = memoryStore(() => clock)
    const hostA = host(store)
    const hostB = host(store)
    hostA.lookup('nap', { id: 'k' }).cast({ type: 'nap' })
    await settle()
    hostA.evict('nap')

    let release = (): void => {}
    hold = new Promise((resolve) => (release = resolve))
    await advance(1000)
    const a = scheduler({ store, wake: (id) => hostA.lookup('nap', { id }), lease: 500, now: () => clock })
    await settle()
    a[Symbol.dispose]() // host A's scheduler goes away; its activation is stuck in 'deliver'
    const first = hostA.lookup('nap', { id: 'k' })
    expect(rung).toStrictEqual(['k'])

    const b = scheduler({ store, wake: (id) => hostB.lookup('nap', { id }), interval: 100, lease: 500, now: () => clock })
    await advance(400)
    expect(delivered).toHaveLength(1) // still leased to A
    await advance(100)
    expect(delivered).toHaveLength(2) // B took the key over and replayed from the journal
    release()
    await settle()

    expect(rung).toStrictEqual(['k']) // the journaled effect ran once
    expect(delivered).toStrictEqual(['k#1#2', 'k#1#2']) // the one in flight ran twice, under one idempotency key
    expect(first.error).toBeUndefined() // A was fenced at its next write: it stopped, not crashed
    expect(await store.load('k')).toMatchObject({ snapshot: { woke: 1 }, cursor: 1 })
    expect(await store.pending('k', 0)).toStrictEqual([])
    b[Symbol.dispose]()
    hostA.evict('nap')
    hostB.evict('nap')
  })
})

// ---------- work in flight ----------

type Job = { done: number }
let ran: string[] = []
let gate: Promise<number> | undefined

/** One journaled effect per message, which waits on `gate` while it is set. */
const worker: DurableProc<Job, Cast<{ type: 'work' }>, { id: string }> = async function* (self, _args, d) {
  let s = d.restored ?? { done: 0 }
  yield s
  for await (const msg of self) {
    switch (msg.type) {
      case 'work':
        await d.step('effect', (key) => (ran.push(key), gate ?? 0))
        s = { done: s.done + 1 }
        break
    }
    yield s
  }
}

const workers = (store: Store, evict?: number) =>
  registry({
    work: define(durable(worker, { store, key: (a: { id: string }) => a.id, now: () => clock, redeliverAfter: 5000 }), evict === undefined ? undefined : { evict }),
  })

const never = (): Promise<number> => new Promise(() => {}) // a host that died mid-effect

describe('work in flight', () => {
  beforeEach(() => {
    ran = []
    gate = undefined
  })

  it('resumes a message interrupted with no deadline once redeliverAfter has passed, with no lookup', async () => {
    const store = memoryStore(() => clock)
    const reg = workers(store)
    gate = never()
    reg.lookup('work', { id: 'w1' }).cast({ type: 'work' })
    await settle()
    reg.evict('work') // nothing holds the key and nothing looks it up
    gate = undefined

    const woken: string[] = []
    const sch = scheduler({ store, wake: (id) => (woken.push(id), reg.lookup('work', { id })), interval: 100, now: () => clock })
    await advance(4900)
    expect(woken).toStrictEqual([])
    await advance(100)
    expect(woken).toStrictEqual(['w1'])
    expect(ran).toStrictEqual(['w1#1#0', 'w1#1#0']) // the step in flight runs again, under the same key
    expect(await store.load('w1')).toMatchObject({ snapshot: { done: 1 }, cursor: 1 })

    await advance(60_000) // acknowledged with nothing behind it: never due again
    expect(woken).toStrictEqual(['w1'])
    sch[Symbol.dispose]()
    reg.evict('work')
  })

  it('messages journaled behind one that was interrupted are redelivered with it', async () => {
    const store = memoryStore(() => clock)
    const reg = workers(store)
    const w = reg.lookup('work', { id: 'w1' })
    gate = never()
    w.cast({ type: 'work' })
    w.cast({ type: 'work' })
    await settle()
    await advance(4000)
    gate = undefined
    reg.evict('work') // died on the first; the second never started
    const woken: string[] = []
    const sch = scheduler({ store, wake: (id) => (woken.push(id), reg.lookup('work', { id })), interval: 100, now: () => clock })
    await settle() // the first pass, at 4000: nothing due yet
    expect(woken).toStrictEqual([])
    await advance(1000) // the first append's wake: redelivered, and both commit
    expect(woken).toStrictEqual(['w1'])
    expect(await store.load('w1')).toMatchObject({ snapshot: { done: 2 }, cursor: 2 })
    sch[Symbol.dispose]()
    reg.evict('work')
  })

  it('an unwatched entry is not idle-evicted mid-message, and is in the first idle window after it commits', async () => {
    const store = memoryStore(() => clock)
    const reg = workers(store, 1000)
    let release!: () => void
    gate = new Promise<number>((resolve) => (release = () => resolve(0)))
    const first = reg.lookup('work', { id: 'w1' })
    first.cast({ type: 'work' })
    await settle()
    await advance(3500) // three idle windows, all while the effect is open
    expect(reg.lookup('work', { id: 'w1' })).toBe(first)

    release()
    await settle()
    expect(first()).toStrictEqual({ done: 1 })
    await advance(1000)
    expect(first.stale).toBe(true) // evicted
    expect(ran).toStrictEqual(['w1#1#0'])
    reg.evict('work')
  })

  it('a sleeping entry is still idle-evicted, and its deadline wakes it', async () => {
    const store = memoryStore(() => clock)
    const reg = registry({
      nap: define(durable(napper, { store, key: (a: { id: string }) => a.id, now: () => clock }), { evict: 300 }),
    })
    const first = reg.lookup('nap', { id: 'n1' })
    first.cast({ type: 'nap' })
    await settle()
    await advance(300)
    expect(first.stale).toBe(true) // asleep on a journaled deadline: nothing to hold it in memory for

    const sch = scheduler({ store, wake: (id) => reg.lookup('nap', { id }), interval: 100, now: () => clock })
    await settle()
    await advance(700)
    expect(rung).toStrictEqual(['n1'])
    sch[Symbol.dispose]()
    reg.evict('nap')
  })
})
