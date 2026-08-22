import { describe, it, expect } from 'vitest'
import { define, registry, effect, derive } from '../src/index.ts'
import type { Proc, Self } from '../src/index.ts'

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
  it('same name + args share one process; different args get their own', async () => {
    const reg = registry({ counter: define(counter) })
    const a1 = reg.lookup('counter', { start: 1 })
    const a2 = reg.lookup('counter', { start: 1 })
    const b = reg.lookup('counter', { start: 2 })
    expect(a1).toBe(a2)
    expect(b).not.toBe(a1)
    await tick()
    a1.send(10)
    await tick()
    expect(a2()).toBe(11) // shared: a2 sees a1's send
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
