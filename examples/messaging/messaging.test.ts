// Adapters are tested against the port's promises; processes are tested against
// the adapters. Time is an argument to the queue, so lease expiry is a variable
// assignment rather than a wait.

import { describe, it, expect } from 'vitest'
import { define, registry, spawn } from '@nonchalant/core'
import { memoryBus, memoryQueue } from './memory.ts'
import { feed, worker, type WorkerState } from './processes.ts'
import type { Job } from './ports.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const waitFor = async (ready: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 2))
  if (!ready()) throw new Error(`never reached: ${what}`)
}

describe('the bus adapter', () => {
  it('delivers a topic to its subscribers and nobody else', async () => {
    const bus = memoryBus()
    const orders: string[] = []
    const alerts: string[] = []
    const stop = bus.subscribe('orders', (e) => orders.push(String(e)))
    bus.subscribe('alerts', (e) => alerts.push(String(e)))

    await bus.publish('orders', 'one')
    await bus.publish('alerts', 'fire')
    expect(orders).toStrictEqual(['one'])
    expect(alerts).toStrictEqual(['fire'])

    stop()
    await bus.publish('orders', 'two') // nobody listening on that topic now
    expect(orders).toStrictEqual(['one'])
    expect(bus.topics()).toStrictEqual(['alerts'])
  })
})

describe('the queue adapter', () => {
  const at = { now: 1_000 }
  const queue = (): ReturnType<typeof memoryQueue> => memoryQueue({ now: () => at.now })

  it('hands a job to one reserver at a time', async () => {
    at.now = 1_000
    const q = queue()
    await q.push('a')
    await q.push('b')

    const first = await q.reserve(5_000)
    const second = await q.reserve(5_000)
    expect(first?.body).toBe('a')
    expect(second?.body).toBe('b')
    expect(await q.reserve(5_000)).toBeUndefined() // both are leased
    expect(await q.stats()).toStrictEqual({ waiting: 0, leased: 2, done: 0 })
  })

  it('gives a job back when its lease runs out, and counts the attempt', async () => {
    at.now = 1_000
    const q = queue()
    await q.push('a')
    const first = await q.reserve(5_000)
    expect(first?.attempts).toBe(1)

    at.now = 6_500 // the holder died somewhere in here
    const again = await q.reserve(5_000)
    expect(again?.id).toBe(first?.id)
    expect(again?.attempts).toBe(2)

    await q.ack(again!.id)
    expect(await q.stats()).toStrictEqual({ waiting: 0, leased: 0, done: 1 })
    expect(q.pending()).toBe(0)
  })

  it('release makes a job visible immediately', async () => {
    at.now = 1_000
    const q = queue()
    await q.push('a')
    const job = await q.reserve(60_000)
    expect(await q.reserve(60_000)).toBeUndefined()
    await q.release(job!.id)
    expect((await q.reserve(60_000))?.id).toBe(job!.id)
  })
})

describe('a subscription as a process', () => {
  it('turns a topic into state, and unsubscribes when it is disposed', async () => {
    const bus = memoryBus()
    const feeds = registry({ feed: define(feed(bus)) })
    const orders = feeds.lookup('feed', { topic: 'orders' })
    await tick()

    await bus.publish('orders', 'first')
    await bus.publish('orders', 'second')
    await waitFor(() => (orders()?.received ?? 0) === 2, 'both events')
    expect(orders()?.events).toStrictEqual(['first', 'second'])

    // the same lookup is the same subscription: one listener, not two
    const alsoOrders = feeds.lookup('feed', { topic: 'orders' })
    expect(alsoOrders).toBe(orders)
    expect(bus.topics()).toStrictEqual(['orders'])

    feeds.evict('feed', { topic: 'orders' })
    await tick()
    expect(bus.topics()).toStrictEqual([]) // disposal is the unsubscribe
  })
})

describe('a queue worker as a process', () => {
  const handled = (name: string) => async (job: Job): Promise<string> => `${name}:${String(job.body)}`

  it('works the queue down and acknowledges as it goes', async () => {
    const q = memoryQueue()
    await q.push('one')
    await q.push('two')
    const w = spawn(worker({ queue: q, leaseMs: 1_000, idleMs: 5, handle: handled('w1') }), { name: 'w1' })

    await waitFor(() => (w()?.done.length ?? 0) === 2, 'both jobs')
    expect(w()?.done).toStrictEqual(['w1:one', 'w1:two'])
    expect(await q.stats()).toStrictEqual({ waiting: 0, leased: 0, done: 2 })
    w[Symbol.dispose]()
  })

  it('a failing handler gives the job back instead of losing it', async () => {
    const q = memoryQueue()
    await q.push('poison')
    let attempts = 0
    const w = spawn(
      worker({
        queue: q,
        leaseMs: 1_000,
        idleMs: 5,
        handle: async (job) => {
          attempts++
          if (attempts < 3) throw new Error('nope')
          return `ok:${String(job.body)}`
        },
      }),
      { name: 'w1' },
    )

    await waitFor(() => (w()?.done.length ?? 0) === 1, 'the third attempt')
    expect(w()?.failed).toBe(2)
    expect(w()?.done).toStrictEqual(['ok:poison'])
    w[Symbol.dispose]()
  })

  it('a worker that dies mid-job loses its lease, and another one finishes it', async () => {
    const at = { now: 1_000 }
    const q = memoryQueue({ now: () => at.now })
    await q.push('slow')

    // this one takes the job and never comes back
    const doomed = spawn(
      worker({
        queue: q,
        leaseMs: 2_000,
        idleMs: 5,
        handle: () => new Promise<string>(() => {}), // never settles
      }),
      { name: 'doomed' },
    )
    await waitFor(() => doomed()?.holding !== null && doomed()?.holding !== undefined, 'the reservation')
    const held = doomed()!.holding
    doomed[Symbol.dispose]()

    const survivor = spawn(
      worker({ queue: q, leaseMs: 2_000, idleMs: 5, handle: handled('w2') }),
      { name: 'w2' },
    )
    await waitFor(() => (survivor()?.done.length ?? 0) === 0 && survivor() !== undefined, 'the survivor to start')
    expect(await q.stats()).toStrictEqual({ waiting: 0, leased: 1, done: 0 }) // still hidden

    at.now = 3_500 // the lease runs out
    await waitFor(() => (survivor()?.done.length ?? 0) === 1, 'the redelivery')
    expect(survivor()?.done).toStrictEqual(['w2:slow'])
    expect(held).not.toBeNull()
    survivor[Symbol.dispose]()
  })
})
