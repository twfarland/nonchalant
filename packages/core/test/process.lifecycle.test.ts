// Lifecycle edges: how a process ends (return, crash, dispose), what its
// iterators and callers see when it does, and what a `finally` may still do.

import { describe, it, expect } from 'vitest'
import { spawn, derive, cell, onProcessError } from '../src/index.ts'
import type { Call, Cast, Proc, Self } from '../src/index.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// fails fast instead of waiting out the test timeout when an iterator hangs
const within = <T>(p: Promise<T>, ms = 500): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))])

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const seen: T[] = []
  for await (const v of it) seen.push(v)
  return seen
}

describe('iterating a process that ends', () => {
  it('ends after a process returns on its own, delivering its last value first', async () => {
    const p = spawn(async function* () {
      yield 1
      yield 2
    }, undefined)
    const seen = await within(collect(p))
    expect(seen.at(-1)).toBe(2)
    p[Symbol.dispose]()
  })

  it('ends after a process crashes, delivering the last good value first', async () => {
    const p = spawn(async function* () {
      yield 'up'
      throw new Error('boom')
    }, undefined)
    const seen = await within(collect(p))
    expect(seen).toEqual(['up'])
    p[Symbol.dispose]()
  })

  it('an iterator opened after the end yields the final value, then ends', async () => {
    const p = spawn(async function* () {
      yield 1
    }, undefined)
    await tick()
    expect(await within(collect(p))).toEqual([1])
  })

  it('two concurrent next() calls on one process iterator both settle, in order', async () => {
    const p = cell(0)
    const it = p[Symbol.asyncIterator]()
    expect((await it.next()).value).toBe(0)
    const a = it.next()
    const b = it.next()
    p.cast(1)
    await tick()
    p.cast(2)
    await tick()
    const [ra, rb] = await within(Promise.all([a, b]))
    expect([ra.value, rb.value]).toEqual([1, 2])
    p[Symbol.dispose]()
  })

  it('two concurrent next() calls on one derive iterator both settle, in order', async () => {
    const p = cell(0)
    const d = derive(() => p() * 10)
    const it = d[Symbol.asyncIterator]()
    expect((await it.next()).value).toBe(0)
    const a = it.next()
    const b = it.next()
    p.cast(1)
    await tick()
    p.cast(2)
    await tick()
    const [ra, rb] = await within(Promise.all([a, b]))
    expect([ra.value, rb.value]).toEqual([10, 20])
    d[Symbol.dispose]()
    expect((await within(it.next())).done).toBe(true)
    p[Symbol.dispose]()
  })

  it('a parked next() ends when the process is disposed', async () => {
    const p = cell(0)
    const it = p[Symbol.asyncIterator]()
    await it.next()
    const parked = it.next()
    p[Symbol.dispose]()
    expect(await within(parked)).toEqual({ value: undefined, done: true })
  })
})

describe('restart with queued calls', () => {
  type Msg =
    | Cast<{ type: 'boom' }>
    | Cast<{ type: 'add'; n: number }>
    | Call<{ type: 'bump' }, number>

  it('a call queued behind a crash rejects and never runs in the restarted instance', async () => {
    let bumps = 0
    const proc: Proc<number, Msg, number> = async function* (self, start) {
      let n = start
      yield n
      for await (const msg of self) {
        switch (msg.type) {
          case 'boom':
            throw new Error('boom')
          case 'add':
            n += msg.n
            break
          case 'bump':
            bumps++
            n++
            msg.reply(n)
            break
        }
        yield n
      }
    }
    const p = spawn(proc, 100, { initial: 100, restart: 'on-crash' })
    p.cast({ type: 'boom' })
    const queued = p.call({ type: 'bump' })
    p.cast({ type: 'add', n: 7 })
    await expect(queued).rejects.toThrow('boom')
    await tick()
    await tick()
    expect(bumps).toBe(0)
    expect(p()).toBe(107) // the cast still replayed; the call did not
    p[Symbol.dispose]()
  })
})

describe('after dispose', () => {
  it('a yield from a body parked at an await is not published and stale stays true', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const p = spawn(async function* () {
      yield 1
      await gate
      yield 2
    }, undefined)
    await tick()
    p[Symbol.dispose]()
    expect(p.stale).toBe(true)
    release()
    await p[Symbol.asyncDispose]()
    expect(p()).toBe(1)
    expect(p.stale).toBe(true)
    expect(p.pending).toBe(false)
  })

  it('a child spawned in a finally that disposal triggers is owned and disposed with the teardown', async () => {
    let child: { stale: boolean } | undefined
    let childFinally = 0
    const parent = spawn(async function* (self: Self<never>) {
      try {
        yield 'up'
        for await (const _ of self) void _
      } finally {
        child = spawn(async function* (childSelf: Self<never>) {
          try {
            yield 'cleanup'
            for await (const _ of childSelf) void _
          } finally {
            childFinally++
          }
        }, undefined)
      }
    }, undefined)
    await tick()
    await parent[Symbol.asyncDispose]()
    expect(child?.stale).toBe(true)
    expect(childFinally).toBe(1)
  })
})

describe('crashes', () => {
  it('a throw while binding the generator parameters is a crash, not a hang', async () => {
    const p = spawn(
      // eslint-disable-next-line require-yield
      async function* (_self: Self<never>, { n }: { n: number }) {
        yield n
      },
      undefined as unknown as { n: number },
    )
    await tick()
    expect(p.pending).toBe(false)
    expect(p.stale).toBe(true)
    expect(p.error).toBeInstanceOf(TypeError)
    await within(p[Symbol.asyncDispose]())
  })

  it('throw undefined still counts as a crash for pending calls', async () => {
    const p = spawn(async function* (self: Self<Call<{ type: 'q' }, number>>) {
      yield 0
      for await (const _ of self) throw undefined
    }, undefined)
    await tick()
    let rejected = false
    await p.call({ type: 'q' }).catch(() => { rejected = true })
    expect(rejected).toBe(true)
    expect(p.stale).toBe(true)
    await expect(p.call({ type: 'q' })).rejects.toThrow(/crashed/)
  })

  it('a derive whose computation throws undefined keeps throwing on read', async () => {
    const flag = cell(false)
    const d = derive(() => {
      if (flag()) throw undefined
      return 1
    })
    expect(d()).toBe(1)
    flag.cast(true)
    await tick()
    let throws = 0
    for (let i = 0; i < 2; i++) {
      try {
        d()
      } catch {
        throws++
      }
    }
    expect(throws).toBe(2)
    d[Symbol.dispose]()
    flag[Symbol.dispose]()
  })

  it('onProcessError sees every crash, restarted or terminal, with the proc name', async () => {
    const seen: [unknown, string][] = []
    const off = onProcessError((error, name) => seen.push([error, name]))
    const flaky = async function* (self: Self<'boom'>) {
      yield 0
      for await (const _ of self) throw new Error('boom')
    }
    const p = spawn(flaky, undefined, { restart: 'on-crash', maxRestarts: 1 })
    await tick()
    p.cast('boom')
    await tick()
    p.cast('boom')
    await tick()
    off()
    const q = spawn(flaky, undefined)
    await tick()
    q.cast('boom')
    await tick()
    expect(seen.length).toBe(2)
    expect(seen.map(([e, name]) => [String(e), name])).toEqual([
      ['Error: boom', 'flaky'],
      ['Error: boom', 'flaky'],
    ])
    p[Symbol.dispose]()
    q[Symbol.dispose]()
  })

  it('a quiet process crashes and restarts without an onProcessError report', async () => {
    const seen: unknown[] = []
    const off = onProcessError((error) => seen.push(error))
    let starts = 0
    const flaky = async function* (self: Self<'boom'>) {
      starts++
      yield 0
      for await (const _ of self) throw new Error('boom')
    }
    const p = spawn(flaky, undefined, { restart: 'on-crash', quiet: true })
    await tick()
    p.cast('boom')
    await tick()
    expect(starts).toBe(2) // it crashed and restarted
    await tick()
    expect(seen).toEqual([])
    off()
    p[Symbol.dispose]()
  })
})

describe('mailbox depth', () => {
  it('queued casts drain in linear time: 4x the backlog costs under 8x the time', async () => {
    // a ratio of two drains on the same runner survives a slow runner where a
    // wall-clock bound does not. O(1) dequeue scales ~4x from 50k to 200k and
    // O(n) dequeue ~16x; each figure is the quietest of three runs
    const drain = async (n: number): Promise<number> => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      let drained!: () => void
      const done = new Promise<void>((resolve) => { drained = resolve })
      let total = 0
      const p = spawn(async function* (self: Self<number>) {
        yield 0
        await gate
        for await (const m of self) {
          total += m
          if (total === n) {
            drained()
            yield total
          }
        }
      }, undefined)
      await tick()
      for (let i = 0; i < n; i++) p.cast(1)
      const start = performance.now()
      release()
      await done
      const elapsed = performance.now() - start
      await tick()
      expect(p()).toBe(n)
      p[Symbol.dispose]()
      return elapsed
    }
    const quietest = async (n: number): Promise<number> => {
      let best = Number.POSITIVE_INFINITY
      for (let run = 0; run < 3; run++) best = Math.min(best, await drain(n))
      return best
    }

    await drain(50_000) // warmup: let the JIT settle
    const small = await quietest(50_000)
    const large = await quietest(200_000)
    expect(large / small).toBeLessThan(8)
  }, 60_000) // a quadratic mailbox takes ~25 s here; let the ratio, not the timeout, report it
})
