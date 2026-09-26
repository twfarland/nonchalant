import { describe, it, expect } from 'vitest'
import { define, registry, effect, derive } from '../src/index.ts'
import type { Call, Cast, Proc, Self } from '../src/index.ts'

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type CounterMsg = number

const counter: Proc<number, CounterMsg, { start: number }> = async function* (self, args) {
  let n = args.start
  yield n
  for await (const d of self) {
    n += d
    yield n
  }
}

describe('registry: lookup is get-or-spawn', () => {
  it('rejects invalid eviction delays', () => {
    expect(() => define(counter, { evict: -1 })).toThrow(/evict/)
    expect(() => define(counter, { evict: Number.NaN })).toThrow(/evict/)
    expect(() => define(counter, { evict: Number.POSITIVE_INFINITY })).toThrow(/evict/)
  })

  it('same name + args share one process; different args get their own', async () => {
    const reg = registry({ counter: define(counter) })
    const a1 = reg.lookup('counter', { start: 1 })
    const a2 = reg.lookup('counter', { start: 1 })
    const b = reg.lookup('counter', { start: 2 })
    expect(a1).toBe(a2)
    expect(b).not.toBe(a1)
    await tick()
    a1.cast(10)
    await tick()
    expect(a2()).toBe(11) // shared: a2 sees a1's cast
    expect(b()).toBe(2)
    reg.evict('counter')
  })

  it('composite args are queryKey-stable: property order does not matter', () => {
    type Args = { a: number; b: number }
    const proc: Proc<number, never, Args> = async function* (_self, { a, b }) {
      yield a + b
    }
    const reg = registry({ sum: define(proc) })
    const x = reg.lookup('sum', { a: 1, b: 2 })
    const y = reg.lookup('sum', { b: 2, a: 1 })
    expect(x).toBe(y)
    reg.evict('sum')
  })

  it('non-data dependencies participate in local cache identity', () => {
    type Args = { read(): number }
    const proc: Proc<number, never, Args> = async function* (_self, args) {
      yield args.read()
    }
    const reg = registry({ value: define(proc) })
    const read1 = (): number => 1
    const read2 = (): number => 2
    expect(reg.lookup('value', { read: read1 })).toBe(reg.lookup('value', { read: read1 }))
    expect(reg.lookup('value', { read: read2 })).not.toBe(reg.lookup('value', { read: read1 }))
    reg.evict('value')
  })

  it('cyclic local arguments are keyed by stable identity instead of throwing', () => {
    interface Args { id: number; self?: Args }
    const proc: Proc<number, never, Args> = async function* (_self, args) {
      yield args.id
    }
    const reg = registry({ value: define(proc) })
    const a: Args = { id: 1 }
    const b: Args = { id: 1 }
    a.self = a
    b.self = b
    expect(reg.lookup('value', a)).toBe(reg.lookup('value', a))
    expect(reg.lookup('value', b)).not.toBe(reg.lookup('value', a))
    reg.evict('value')
  })

  it('unknown names throw', () => {
    const reg = registry({ counter: define(counter) })
    expect(() => (reg as unknown as { lookup: (n: string) => unknown }).lookup('nope')).toThrow(/no definition/)
  })
})

describe('registry: watcher refcounting and eviction', () => {
  const makeTracked = (): { proc: Proc<number, never, { id: number }>; log: string[] } => {
    const log: string[] = []
    const proc: Proc<number, never, { id: number }> = async function* (self, { id }) {
      log.push(`spawn ${id}`)
      try {
        yield id
        for await (const _ of self) void _
      } finally {
        log.push(`dispose ${id}`)
      }
    }
    return { proc, log }
  }

  it('evicts after the last watcher leaves and the idle timeout passes', async () => {
    const { proc, log } = makeTracked()
    const reg = registry({ item: define(proc, { evict: 20 }) })
    const p = reg.lookup('item', { id: 1 })
    await tick()
    const stop = effect(() => void p())
    stop()
    await tick(60)
    expect(log).toEqual(['spawn 1', 'dispose 1'])
    const again = reg.lookup('item', { id: 1 })
    expect(again).not.toBe(p) // fresh spawn after eviction
    await tick()
    expect(log).toEqual(['spawn 1', 'dispose 1', 'spawn 1'])
    reg.evict('item')
  })

  it('a returning watcher cancels the eviction timer', async () => {
    const { proc, log } = makeTracked()
    const reg = registry({ item: define(proc, { evict: 30 }) })
    const p = reg.lookup('item', { id: 7 })
    await tick()
    const s1 = effect(() => void p())
    s1()
    await tick(10)
    const s2 = effect(() => void p()) // back before the timer fires
    await tick(60)
    expect(log).toEqual(['spawn 7']) // never evicted
    expect(reg.lookup('item', { id: 7 })).toBe(p)
    s2()
    reg.evict('item')
  })

  it('derives count as watchers too', async () => {
    const { proc, log } = makeTracked()
    const reg = registry({ item: define(proc, { evict: 15 }) })
    const p = reg.lookup('item', { id: 3 })
    await tick()
    const d = derive(() => (p() ?? 0) * 2)
    const stop = effect(() => void d())
    expect(d()).toBe(6)
    stop()
    d[Symbol.dispose]()
    await tick(50)
    expect(log).toEqual(['spawn 3', 'dispose 3'])
    reg.evict('item')
  })

  it('lifecycle metadata readers keep an entry alive', async () => {
    const { proc, log } = makeTracked()
    const reg = registry({ item: define(proc, { evict: 15 }) })
    const p = reg.lookup('item', { id: 4 })
    const stop = effect(() => void p.error)
    await tick(50)
    expect(reg.lookup('item', { id: 4 })).toBe(p)
    expect(log).toEqual(['spawn 4'])
    stop()
    await tick(50)
    expect(log).toEqual(['spawn 4', 'dispose 4'])
    reg.evict('item')
  })

  it('an entry that is never watched still expires when idle', async () => {
    const { proc, log } = makeTracked()
    const reg = registry({ item: define(proc, { evict: 15 }) })
    const p = reg.lookup('item', { id: 5 })
    await tick(50)
    expect(log).toEqual(['spawn 5', 'dispose 5'])
    expect(reg.lookup('item', { id: 5 })).not.toBe(p)
    reg.evict('item')
  })

  it('a naturally completed entry is removed from the cache', async () => {
    let spawns = 0
    const once: Proc<number, never, void> = async function* () {
      spawns++
      yield spawns
    }
    const reg = registry({ once: define(once) })
    const first = reg.lookup('once')
    await tick()
    const second = reg.lookup('once')
    expect(second).not.toBe(first)
    await tick()
    expect(second()).toBe(2)
    reg.evict('once')
  })

  it('manual evict disposes one entry, or all entries under a name', async () => {
    const { proc, log } = makeTracked()
    const reg = registry({ item: define(proc) })
    reg.lookup('item', { id: 1 })
    reg.lookup('item', { id: 2 })
    reg.lookup('item', { id: 3 })
    await tick()
    reg.evict('item', { id: 2 })
    await tick()
    expect(log.filter((l) => l.startsWith('dispose'))).toEqual(['dispose 2'])
    reg.evict('item')
    await tick()
    expect(log.filter((l) => l.startsWith('dispose')).sort()).toEqual(['dispose 1', 'dispose 2', 'dispose 3'])
  })

  it('a registry process is not owned by the process that looked it up', async () => {
    const { proc, log } = makeTracked()
    const reg = registry({ shared: define(proc) })
    const looker: Proc<string, never, void> = async function* (self) {
      reg.lookup('shared', { id: 42 }) // inside a process body: must NOT attach to its scope
      yield 'up'
      for await (const _ of self) void _
    }
    const { spawn } = await import('../src/index.ts')
    const p = spawn(looker, undefined)
    await tick()
    p[Symbol.dispose]()
    await tick()
    expect(log).toEqual(['spawn 42']) // survived the looker's death
    reg.evict('shared')
  })
})

describe('the query-cache recipe (SWR in twenty lines of userland)', () => {
  it('dedups in-flight fetches, shares results, refetches after idle eviction', async () => {
    let fetches = 0
    const fakeFetch = async (id: number): Promise<{ id: number; name: string }> => {
      fetches++
      await tick()
      return { id, name: `user ${id}` }
    }
    type User = { id: number; name: string }
    const userQuery: Proc<User, never, { id: number }> = async function* (self, { id }) {
      yield await fakeFetch(id)
      for await (const _ of self) void _ // stay alive for watchers
    }
    const users = registry({ user: define(userQuery, { evict: 20 }) })

    // two "components" ask for the same user: one spawn, one fetch
    const a = users.lookup('user', { id: 1 })
    const b = users.lookup('user', { id: 1 })
    expect(a).toBe(b)
    await tick(5)
    expect(a()?.name).toBe('user 1')
    expect(fetches).toBe(1)

    // watchers leave; entry idles out; next lookup refetches (SWR lifecycle)
    const stop = effect(() => void a())
    stop()
    await tick(60)
    const c = users.lookup('user', { id: 1 })
    expect(c).not.toBe(a)
    await tick(5)
    expect(fetches).toBe(2)
    users.evict('user')
  })
})

describe('registry: snapshot derives do not pin entries', () => {
  it('a derive read once outside any effect lets the entry idle out', async () => {
    const log: string[] = []
    const proc: Proc<number, never, void> = async function* (self) {
      log.push('spawn')
      try {
        yield 1
        for await (const _ of self) void _
      } finally {
        log.push('dispose')
      }
    }
    const reg = registry({ x: define(proc, { evict: 15 }) })
    reg.lookup('x')
    await tick()
    const d = derive(() => reg.lookup('x')())
    expect(d()).toBe(1)
    await tick(50)
    expect(log).toEqual(['spawn', 'dispose'])
    d[Symbol.dispose]()
  })
})

describe('registry: maxEntries bounds the cache', () => {
  const tracked = (): { proc: Proc<number, never, number>; live: Set<number> } => {
    const live = new Set<number>()
    const proc: Proc<number, never, number> = async function* (self, id) {
      live.add(id)
      try {
        yield id
        for await (const _ of self) void _
      } finally {
        live.delete(id)
      }
    }
    return { proc, live }
  }

  it('rejects a cap that is not positive', () => {
    const { proc } = tracked()
    expect(() => registry({ v: define(proc) }, { maxEntries: 0 })).toThrow(/maxEntries/)
    expect(() => registry({ v: define(proc) }, { maxEntries: -1 })).toThrow(/maxEntries/)
    expect(() => registry({ v: define(proc) }, { maxEntries: Number.NaN })).toThrow(/maxEntries/)
  })

  it('evicts the least recently looked-up entry once the cap is passed', async () => {
    const { proc, live } = tracked()
    const reg = registry({ v: define(proc) }, { maxEntries: 2 })
    const one = reg.lookup('v', 1)
    reg.lookup('v', 2)
    await tick()
    expect(reg.lookup('v', 1)).toBe(one) // 1 is now the most recent
    reg.lookup('v', 3)
    await tick()
    expect([...live].sort()).toEqual([1, 3])
    reg.evict('v')
  })

  it('distinct args cannot grow the cache past the cap', async () => {
    const { proc, live } = tracked()
    const reg = registry({ v: define(proc) }, { maxEntries: 3 })
    for (let i = 0; i < 100; i++) reg.lookup('v', i)
    await tick()
    expect([...live].sort((a, b) => a - b)).toEqual([97, 98, 99])
    reg.evict('v')
  })

  it('watched entries are never evicted to make room', async () => {
    const { proc, live } = tracked()
    const reg = registry({ v: define(proc) }, { maxEntries: 1 })
    const first = reg.lookup('v', 1)
    const stop = effect(() => void first())
    reg.lookup('v', 2)
    reg.lookup('v', 3)
    await tick()
    expect([...live].sort()).toEqual([1, 3])
    expect(reg.lookup('v', 1)).toBe(first)
    stop()
    reg.evict('v')
  })

  it('an entry holding unanswered calls is not evicted to make room', async () => {
    type Msg = Call<{ type: 'get' }, number> | Cast<{ type: 'go' }>
    const held: Proc<number, Msg, number> = async function* (self, id) {
      let waiting: Extract<Msg, { type: 'get' }>[] = []
      yield id
      for await (const msg of self) {
        switch (msg.type) {
          case 'get':
            waiting = [...waiting, msg]
            continue
          case 'go':
            for (const w of waiting) w.reply(id)
            waiting = []
            continue
        }
      }
    }
    const reg = registry({ h: define(held) }, { maxEntries: 1 })
    const first = reg.lookup('h', 1)
    await tick()
    const answers = [first.call({ type: 'get' }), first.call({ type: 'get' })]
    await tick()
    reg.lookup('h', 2)
    await tick()
    expect(reg.lookup('h', 1)).toBe(first)
    first.cast({ type: 'go' })
    expect(await Promise.all(answers)).toEqual([1, 1])
    reg.evict('h')
  })
})

describe('registry: a busy process is not evicted', () => {
  // holds self.busy() between 'hold' and 'let-go'; each hold nests
  type Msg = Cast<{ type: 'hold' }> | Cast<{ type: 'let-go' }>
  const holder = (log: string[]): Proc<number, Msg, number> =>
    async function* (self, id) {
      const holds: Disposable[] = []
      try {
        yield id
        for await (const msg of self) {
          switch (msg.type) {
            case 'hold':
              holds.push(self.busy())
              continue
            case 'let-go':
              holds.pop()?.[Symbol.dispose]()
              continue
          }
        }
      } finally {
        log.push(`dispose ${id}`)
      }
    }

  it('idle eviction waits out a hold, window by window, and drops it in the first window after release', async () => {
    const log: string[] = []
    const reg = registry({ h: define(holder(log), { evict: 20 }) })
    const p = reg.lookup('h', 1)
    p.cast({ type: 'hold' })
    p.cast({ type: 'hold' })
    await tick(70) // three windows
    expect(log).toEqual([])
    p.cast({ type: 'let-go' })
    await tick(30)
    expect(log).toEqual([]) // one hold left
    p.cast({ type: 'let-go' })
    await tick(50)
    expect(log).toEqual(['dispose 1'])
  })

  it('a hold keeps an entry from being evicted to make room', async () => {
    const log: string[] = []
    const reg = registry({ h: define(holder(log)) }, { maxEntries: 1 })
    const first = reg.lookup('h', 1)
    first.cast({ type: 'hold' })
    await tick()
    reg.lookup('h', 2)
    await tick()
    expect(reg.lookup('h', 1)).toBe(first)
    expect(log).toEqual([]) // over the cap until the hold is let go, as with a watched entry
    reg.evict('h')
  })

  it('disposing one hold twice releases it once', async () => {
    const log: string[] = []
    const reg = registry({
      h: define(async function* (self: Self<'go'>, id: number) {
        const a = self.busy()
        const b = self.busy()
        a[Symbol.dispose]()
        a[Symbol.dispose]() // must not release b
        try {
          yield id
          for await (const _ of self) b[Symbol.dispose]()
        } finally {
          log.push(`dispose ${id}`)
        }
      }, { evict: 20 }),
    })
    const p = reg.lookup('h', 1)
    await tick(50)
    expect(log).toEqual([])
    p.cast('go')
    await tick(50)
    expect(log).toEqual(['dispose 1'])
  })

  it('explicit evict disposes a busy entry: it is how work in flight is stopped', async () => {
    const log: string[] = []
    const reg = registry({ h: define(holder(log), { evict: 20 }) })
    reg.lookup('h', 1).cast({ type: 'hold' })
    await tick()
    reg.evict('h')
    await tick()
    expect(log).toEqual(['dispose 1'])
  })
})

describe('registry: cache keys distinguish every argument value', () => {
  const echo: Proc<unknown, never, unknown> = async function* (self) {
    yield null
    for await (const _ of self) void _
  }

  it('same value, same entry; different value, different entry', () => {
    const reg = registry({ v: define(echo) })
    const same = (a: unknown, b: unknown): boolean =>
      (reg.lookup as (n: 'v', x: unknown) => unknown)('v', a) === (reg.lookup as (n: 'v', x: unknown) => unknown)('v', b)
    const sym = Symbol('s')
    expect(same(Number.NaN, Number.NaN)).toBe(true)
    expect(same(Number.NaN, 'NaN')).toBe(false)
    expect(same(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(true)
    expect(same(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)).toBe(false)
    expect(same(Number.POSITIVE_INFINITY, null)).toBe(false) // JSON.stringify would say null
    expect(same(-0, -0)).toBe(true)
    expect(same(-0, 0)).toBe(false)
    expect(same(1n, 1n)).toBe(true)
    expect(same(1n, 1)).toBe(false)
    expect(same(1n, '1')).toBe(false)
    expect(same(sym, sym)).toBe(true)
    expect(same(sym, Symbol('s'))).toBe(false)
    expect(same([, 1], [, 1])).toBe(true) // eslint-disable-line no-sparse-arrays
    expect(same([, 1], [undefined, 1])).toBe(false) // eslint-disable-line no-sparse-arrays
    expect(same([, 1], [null, 1])).toBe(false) // eslint-disable-line no-sparse-arrays
    expect(same({ a: undefined }, {})).toBe(false)
    reg.evict('v')
  })
})
