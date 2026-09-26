// The mailbox on its own: the Fifo's order and compaction, and the delivery
// rules (direct hand-off, latest() conflation, bound, close) without a
// process around it.

import { describe, it, expect, vi } from 'vitest'
import { Fifo, Mailbox, type MailboxHooks } from '../src/mailbox.ts'

// the backing array, to pin when compaction happens
const backing = <T>(q: Fifo<T>): (T | undefined)[] => (q as unknown as { items: (T | undefined)[] }).items

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('Fifo', () => {
  it('shifts in push order and reports the remaining size', () => {
    const q = new Fifo<number>()
    for (let i = 0; i < 5; i++) q.push(i)
    expect(q.size()).toBe(5)
    expect(q.peek()).toBe(0)
    expect([q.shift(), q.shift()]).toStrictEqual([0, 1])
    expect(q.size()).toBe(3)
    expect(q.peek()).toBe(2)
  })

  it('peeks undefined when empty', () => {
    const q = new Fifo<number>()
    expect(q.peek()).toBeUndefined()
    q.push(1)
    q.shift()
    expect(q.peek()).toBeUndefined()
    expect(q.size()).toBe(0)
  })

  it('clears a consumed slot at once, before any compaction', () => {
    const q = new Fifo<object>()
    const a = {}
    q.push(a)
    q.push({})
    q.push({})
    q.push({})
    expect(q.shift()).toBe(a)
    expect(backing(q)).toHaveLength(4)
    expect(backing(q)[0]).toBeUndefined()
  })

  it('compacts exactly when the consumed prefix reaches half the array', () => {
    const q = new Fifo<number>()
    for (let i = 0; i < 6; i++) q.push(i)
    q.shift()
    q.shift()
    expect(backing(q)).toHaveLength(6) // 2 of 6 consumed: below half
    q.shift()
    expect(backing(q)).toStrictEqual([3, 4, 5]) // 3 of 6: compacted
    expect(q.size()).toBe(3)
  })

  it('keeps order across repeated compactions with interleaved pushes', () => {
    const q = new Fifo<number>()
    const out: number[] = []
    let next = 0
    for (let round = 0; round < 50; round++) {
      for (let i = 0; i < 3; i++) q.push(next++)
      for (let i = 0; i < 2; i++) out.push(q.shift())
    }
    while (q.size() > 0) out.push(q.shift())
    expect(out).toStrictEqual(Array.from({ length: 150 }, (_, i) => i))
  })

  it('drains the unconsumed rest and starts over empty', () => {
    const q = new Fifo<number>()
    for (let i = 0; i < 5; i++) q.push(i)
    q.shift()
    expect(q.drain()).toStrictEqual([1, 2, 3, 4])
    expect(q.size()).toBe(0)
    q.push(9)
    expect(q.shift()).toBe(9)
  })
})

// hooks that record what the mailbox reports
const recorder = <In>(bound?: number): { hooks: MailboxHooks<In>; log: string[]; dropped: In[] } => {
  const log: string[] = []
  const dropped: In[] = []
  const hooks: MailboxHooks<In> = {
    bound,
    onDrop: (msg) => {
      dropped.push(msg)
      log.push('drop')
    },
    onDeliver: () => log.push('deliver'),
    onIdle: () => log.push('idle'),
  }
  return { hooks, log, dropped }
}

describe('Mailbox', () => {
  it('takes queued messages in order, reporting a delivery for each', async () => {
    const { hooks, log } = recorder<number>()
    const box = new Mailbox(hooks)
    box.push(1)
    box.push(2)
    expect(await box.take(false)).toStrictEqual({ value: 1, done: false })
    expect(await box.take(false)).toStrictEqual({ value: 2, done: false })
    expect(log).toStrictEqual(['deliver', 'deliver'])
  })

  it('reports idle and parks on an empty queue; a push hands over directly', async () => {
    const { hooks, log } = recorder<number>()
    const box = new Mailbox(hooks)
    const taken = box.take(false)
    expect(log).toStrictEqual(['idle'])
    box.push(7)
    expect(log).toStrictEqual(['idle', 'deliver'])
    expect(box.queue.size()).toBe(0)
    expect(await taken).toStrictEqual({ value: 7, done: false })
  })

  it('latest() on a full queue takes the newest and drops the rest', async () => {
    const { hooks, log, dropped } = recorder<number>()
    const box = new Mailbox(hooks)
    box.push(1)
    box.push(2)
    box.push(3)
    expect(await box.take(true)).toStrictEqual({ value: 3, done: false })
    expect(dropped).toStrictEqual([1, 2])
    expect(log).toStrictEqual(['drop', 'drop', 'deliver'])
  })

  it('a parked latest() taker receives the newest of a same-tick burst', async () => {
    const { hooks, dropped } = recorder<number>()
    const box = new Mailbox(hooks)
    const taken = box.take(true)
    box.push(1)
    box.push(2)
    box.push(3)
    expect(box.queue.size()).toBe(3)
    expect(await taken).toStrictEqual({ value: 3, done: false })
    expect(dropped).toStrictEqual([1, 2])
    expect(box.queue.size()).toBe(0)
  })

  it('overflow past the bound drops the oldest message and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { hooks, dropped } = recorder<number>(2)
      const box = new Mailbox(hooks)
      for (let i = 1; i <= 5; i++) box.push(i)
      expect(dropped).toStrictEqual([1, 2, 3])
      expect(box.queue.drain()).toStrictEqual([4, 5])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('a bound of 0 drops every message nobody is waiting for', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { hooks, dropped } = recorder<number>(0)
      const box = new Mailbox(hooks)
      box.push(1)
      expect(dropped).toStrictEqual([1])
      const taken = box.take(false)
      box.push(2)
      expect(await taken).toStrictEqual({ value: 2, done: false })
      expect(dropped).toStrictEqual([1])
    } finally {
      warn.mockRestore()
    }
  })

  it('close ends parked takers and drops later pushes', async () => {
    const { hooks, dropped } = recorder<number>()
    const box = new Mailbox(hooks)
    const parked = box.take(false)
    box.close()
    expect(await parked).toStrictEqual({ value: undefined, done: true })
    box.push(9)
    expect(dropped).toStrictEqual([9])
  })

  it('close drops every queued message, in order', () => {
    const { hooks, dropped } = recorder<number>()
    const box = new Mailbox(hooks)
    box.push(1)
    box.push(2)
    box.close()
    expect(dropped).toStrictEqual([1, 2])
    expect(box.queue.size()).toBe(0)
  })

  it('take after close reports done once the queue is empty', async () => {
    const box = new Mailbox<number>({})
    box.close()
    expect(await box.take(false)).toStrictEqual({ value: undefined, done: true })
    expect(await box.take(true)).toStrictEqual({ value: undefined, done: true })
  })

  it('close runs the taker resolution inside the wrapper, once', async () => {
    const box = new Mailbox<number>({})
    const order: string[] = []
    const parked = box.take(false).then(() => order.push('resumed'))
    box.close((resolveTakers) => {
      order.push('before')
      resolveTakers()
      order.push('after')
    })
    box.close(() => order.push('second close'))
    await parked
    expect(order).toStrictEqual(['before', 'after', 'resumed'])
  })

  it('a latest() delivery scheduled before close is abandoned', async () => {
    const { hooks, log } = recorder<number>()
    const box = new Mailbox(hooks)
    const taken = box.take(true)
    box.push(1)
    box.close()
    expect(await taken).toStrictEqual({ value: undefined, done: true })
    await tick()
    expect(log).toStrictEqual(['idle', 'drop'])
  })
})
