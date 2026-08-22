import { describe, it, expect } from 'vitest'
import { spawn, channel, cell, derive, flush } from '../src/index.ts'
import { effect } from '../src/graph.ts'
import type { Call, Proc, Self } from '../src/index.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// a reduce-style counter: initial read comes from `initial`, then one yield per message
const counter: Proc<number, number, void> = async function* (self) {
  let n = 0
  for await (const d of self) {
    n += d
    yield n
  }
}

describe('spawn basics', () => {
  it('initial decides the first read; yields update it', async () => {
    const p = spawn(counter, undefined, { initial: 0 })
    expect(p()).toBe(0)
    p.send(5)
    await tick()
    expect(p()).toBe(5)
    p.send(-2)
    await tick()
    expect(p()).toBe(3)
    p[Symbol.dispose]()
  })

  it('without initial, reads are undefined until the first yield; pending tracks the mailbox', async () => {
    const p = spawn(
      async function* (self: Self<never>) {
        await tick() // simulate startup work
        yield 'ready'
        for await (const _ of self) void _
      },
      undefined,
    )
    expect(p()).toBeUndefined()
    expect(p.pending).toBe(true)
    await tick()
    await tick()
    expect(p()).toBe('ready')
    expect(p.pending).toBe(false)
    p[Symbol.dispose]()
  })

  it('cell is working sugar over spawn', async () => {
    const open = cell(false)
    expect(open()).toBe(false)
    open.send(true)
    await tick()
    expect(open()).toBe(true)
    open[Symbol.dispose]()
  })

  it('rejects invalid mailbox and restart bounds', () => {
    expect(() => spawn(counter, undefined, { initial: 0, mailbox: -1 })).toThrow(/mailbox/)
    expect(() => spawn(counter, undefined, { initial: 0, mailbox: 1.5 })).toThrow(/mailbox/)
    expect(() => spawn(counter, undefined, { initial: 0, maxRestarts: -1 })).toThrow(/maxRestarts/)
    expect(() => spawn(counter, undefined, { initial: 0, maxRestarts: Number.NaN })).toThrow(/maxRestarts/)
  })
})

describe('graph integration', () => {
  it('process yields wake readers path-precisely', async () => {
    type S = { a: number; b: number }
    type Msg = 'a' | 'b'
    const p = spawn(
      async function* (self: Self<Msg>) {
        let s: S = { a: 0, b: 0 }
        for await (const msg of self) {
          s = msg === 'a' ? { ...s, a: s.a + 1 } : { ...s, b: s.b + 1 }
          yield s
        }
      },
      undefined,
      { initial: { a: 0, b: 0 } },
    )
    let aRuns = 0
    let bRuns = 0
    const stops = [
      effect(() => { aRuns++; void p().a }),
      effect(() => { bRuns++; void p().b }),
    ]
    expect([aRuns, bRuns]).toEqual([1, 1])
    p.send('a')
    await tick()
    expect([aRuns, bRuns]).toEqual([2, 1])
    p.send('b')
    await tick()
    expect([aRuns, bRuns]).toEqual([2, 2])
    for (const stop of stops) stop()
    p[Symbol.dispose]()
  })

  it('derives compose over processes', async () => {
    const p = spawn(counter, undefined, { initial: 0 })
    const doubled = derive(() => p() * 2)
    expect(doubled()).toBe(0)
    p.send(3)
    await tick()
    expect(doubled()).toBe(6)
    p[Symbol.dispose]()
  })

  it('non-plain immutable values are tracked as atomic leaves', async () => {
    const p = cell(new Date(0))
    let seen = -1
    const stop = effect(() => {
      seen = p().getTime()
    })
    expect(seen).toBe(0)
    p.send(new Date(1000))
    await tick()
    expect(seen).toBe(1000)
    stop()
    p[Symbol.dispose]()
  })
})

type CartMsg =
  | { type: 'add'; n: number }
  | { type: 'boom' }
  | Call<{ type: 'sum' }, { sum: number }>

const cart: Proc<number, CartMsg, { start: number }> = async function* (self, args) {
  let sum = args.start
  yield sum
  for await (const msg of self) {
    if (msg.type === 'add') {
      sum += msg.n
      yield sum
    } else if (msg.type === 'sum') {
      msg.reply({ sum })
    } else {
      throw new Error('boom')
    }
  }
}

describe('ask / reply', () => {
  it('round-trips a typed call', async () => {
    const p = spawn(cart, { start: 10 }, { initial: 10 })
    p.send({ type: 'add', n: 5 })
    const res = await p.ask({ type: 'sum' })
    expect(res).toEqual({ sum: 15 })
    p[Symbol.dispose]()
  })

  it('rejects pending asks on crash; readers keep the last value, stale', async () => {
    const p = spawn(cart, { start: 1 }, { initial: 1 })
    p.send({ type: 'add', n: 1 })
    await tick()
    expect(p()).toBe(2)
    p.send({ type: 'boom' })
    const q = p.ask({ type: 'sum' }) // queued behind the crash
    await expect(q).rejects.toThrow('boom')
    await tick()
    expect(p()).toBe(2) // last value retained
    expect(p.stale).toBe(true)
    expect(p.error).toBeInstanceOf(Error)
    await expect(p.ask({ type: 'sum' })).rejects.toThrow(/crashed/)
    p[Symbol.dispose]()
  })

  it('rejects asks after normal completion', async () => {
    const p = spawn(
      async function* (_self: Self<Call<{ type: 'q' }, number>>) {
        yield 1
      },
      undefined,
    )
    await tick()
    await expect(p.ask({ type: 'q' })).rejects.toThrow(/done/)
    p[Symbol.dispose]()
  })
})

describe('restart policies', () => {
  it('on-crash restarts from init args and replays queued casts', async () => {
    const p = spawn(cart, { start: 100 }, { initial: 100, restart: 'on-crash' })
    p.send({ type: 'add', n: 1 })
    await tick()
    expect(p()).toBe(101)
    p.send({ type: 'boom' })
    p.send({ type: 'add', n: 7 }) // queued during the crash; replays into the new instance
    await tick()
    await tick()
    expect(p()).toBe(107) // state reset to args (100), then the replayed cast
    expect(p.stale).toBe(false) // recovered
    expect(p.error).toBeUndefined()
    p[Symbol.dispose]()
  })

  it('maxRestarts exceeded is a terminal crash', async () => {
    const p = spawn(cart, { start: 0 }, { initial: 0, restart: 'on-crash', maxRestarts: 1 })
    p.send({ type: 'boom' })
    await tick()
    p.send({ type: 'boom' })
    await tick()
    await tick()
    expect(p.stale).toBe(true)
    expect(String(p.error)).toMatch(/boom/)
    p[Symbol.dispose]()
  })
})

describe('mailbox modes', () => {
  it('latest() drops the queue and skips to the newest message', async () => {
    const seen: number[] = []
    const p = spawn(
      async function* (self: Self<number>) {
        yield 0
        for await (const m of self.latest()) {
          seen.push(m)
          yield m
        }
      },
      undefined,
      { initial: 0 },
    )
    await tick()
    p.send(1)
    await tick()
    p.send(2)
    p.send(3)
    p.send(4)
    await tick()
    expect(seen).toEqual([1, 4])
    expect(p()).toBe(4)
    p[Symbol.dispose]()
  })

  it('a bounded mailbox drops oldest on overflow', async () => {
    const seen: number[] = []
    const p = spawn(
      async function* (self: Self<number>) {
        yield 0
        await new Promise((resolve) => setTimeout(resolve, 10)) // let the queue build
        for await (const m of self) {
          seen.push(m)
          yield m
        }
      },
      undefined,
      { initial: 0, mailbox: 2 },
    )
    await tick()
    for (const n of [1, 2, 3, 4, 5]) p.send(n)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(seen).toEqual([4, 5])
    p[Symbol.dispose]()
  })

  it('self.send posts to the own inbox', async () => {
    const p = spawn(
      async function* (self: Self<'kick' | 'finish'>) {
        yield 'idle'
        for await (const m of self) {
          if (m === 'kick') self.send('finish')
          else yield 'finished'
        }
      },
      undefined,
      { initial: 'idle' },
    )
    p.send('kick')
    await tick()
    expect(p()).toBe('finished')
    p[Symbol.dispose]()
  })
})

describe('channel', () => {
  it('is a standalone FIFO Self', async () => {
    const ch = channel<number>()
    ch.send(1)
    ch.send(2)
    const got: number[] = []
    for await (const m of ch) {
      got.push(m)
      if (got.length === 2) break
    }
    expect(got).toEqual([1, 2])
  })

  it('closes when its signal aborts', async () => {
    const ac = new AbortController()
    const ch = channel<number>(ac.signal)
    ch.send(1)
    const got: number[] = []
    const done = (async () => {
      for await (const m of ch) got.push(m)
    })()
    ac.abort()
    await done
    expect(got).toEqual([1])
  })

  it('can be closed explicitly', async () => {
    const ch = channel<number>()
    const next = ch[Symbol.asyncIterator]().next()
    ch[Symbol.dispose]()
    expect(ch.signal.aborted).toBe(true)
    expect(await next).toEqual({ value: undefined, done: true })
  })
})

describe('disposal cascade', () => {
  it('synchronous disposal starts teardown without waiting for an async finalizer', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let finalized = false
    const p = spawn(
      async function* (self: Self<never>) {
        try {
          yield 'running'
          for await (const _ of self) void _
        } finally {
          await gate
          finalized = true
        }
      },
      undefined,
    )
    await tick()

    p[Symbol.dispose]()
    expect(finalized).toBe(false)
    release()
    await p[Symbol.asyncDispose]()
    expect(finalized).toBe(true)
  })

  it('async disposal waits for parent and owned-child finalizers', async () => {
    const order: string[] = []
    let releaseParent!: () => void
    let releaseChild!: () => void
    const parentGate = new Promise<void>((resolve) => { releaseParent = resolve })
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve })
    const parent = spawn(
      async function* (self: Self<never>) {
        try {
          spawn(
            async function* (childSelf: Self<never>) {
              try {
                yield 'owned-child'
                for await (const _ of childSelf) void _
              } finally {
                await childGate
                order.push('owned-child')
              }
            },
            undefined,
          )
          yield 'parent'
          for await (const _ of self) void _
        } finally {
          await parentGate
          order.push('parent')
        }
      },
      undefined,
    )
    await tick()

    const disposed = parent[Symbol.asyncDispose]()
    await tick()
    expect(order).toEqual([])
    releaseParent()
    await tick()
    expect(order).toEqual(['parent'])
    releaseChild()
    await disposed
    expect(order).toEqual(['parent', 'owned-child'])
  })

  it('mailbox closes, finally runs, owned children die — in order', async () => {
    const order: string[] = []
    const child: Proc<number, never, void> = async function* (self) {
      try {
        yield 1
        for await (const _ of self) void _
      } finally {
        order.push('child-finally')
      }
    }
    const parent = spawn(
      async function* (self: Self<never>) {
        spawn(child, undefined) // ambient scope: attaches to this process
        try {
          yield 'up'
          for await (const _ of self) void _
        } finally {
          order.push('parent-finally')
        }
      },
      undefined,
    )
    await tick()
    parent[Symbol.dispose]()
    await tick()
    expect(order).toEqual(['parent-finally', 'child-finally'])
  })

  it('a crashed instance takes its children with it', async () => {
    let childFinally = 0
    const child: Proc<number, never, void> = async function* (self) {
      try {
        yield 1
        for await (const _ of self) void _
      } finally {
        childFinally++
      }
    }
    const p = spawn(
      async function* (self: Self<'boom'>) {
        spawn(child, undefined)
        yield 'up'
        for await (const _ of self) throw new Error('crash')
      },
      undefined,
      { restart: 'on-crash', maxRestarts: 1 },
    )
    await tick()
    p.send('boom')
    await tick()
    await tick()
    expect(childFinally).toBeGreaterThanOrEqual(1) // the crashed instance's child died
    p[Symbol.dispose]()
  })

  it('the abort signal fires on dispose', async () => {
    let aborted = false
    const p = spawn(
      async function* (self: Self<never>) {
        self.signal.addEventListener('abort', () => {
          aborted = true
        })
        yield 'up'
        for await (const _ of self) void _
      },
      undefined,
    )
    await tick()
    p[Symbol.dispose]()
    expect(aborted).toBe(true)
  })
})

describe('process async iteration', () => {
  it('delivers raw (unproxied) latest values, lossily', async () => {
    const p = spawn(counter, undefined, { initial: 0 })
    const it = p[Symbol.asyncIterator]()
    expect((await it.next()).value).toBe(0)
    p.send(1)
    await tick()
    expect((await it.next()).value).toBe(1)
    p.send(1)
    p.send(1)
    await tick()
    expect((await it.next()).value).toBe(3) // 2 was dropped: lossy latest
    p[Symbol.dispose]()
    expect((await it.next()).done).toBe(true)
  })

  it('object yields arrive unproxied (writable check)', async () => {
    const p = spawn(
      async function* (self: Self<number>) {
        for await (const n of self) yield { n }
      },
      undefined,
      { initial: { n: 0 } },
    )
    const it = p[Symbol.asyncIterator]()
    const first = (await it.next()).value
    expect(first).toBe(p()) // identity: the raw snapshot, not a tracked proxy
    p[Symbol.dispose]()
    await it.return!()
  })
})
