// The shared async-iterator face on its own: lossy latest-value delivery,
// ending through the closers, and a throwing pull.

import { describe, it, expect } from 'vitest'
import { flush, source } from '../src/graph.ts'
import { iterate, NONE } from '../src/iterate.ts'

describe('iterate', () => {
  it('delivers the latest value, deduplicated, and ends when a closer runs', async () => {
    const s = source<{ n: number }>({ n: 1 })
    const closers = new Set<() => void>()
    const it = iterate(() => s().n, closers, true)
    expect(await it.next()).toStrictEqual({ value: 1, done: false })
    s.publish({ n: 2 })
    s.publish({ n: 3 })
    flush()
    expect(await it.next()).toStrictEqual({ value: 3, done: false })
    expect(closers.size).toBe(1)
    for (const end of [...closers]) end()
    expect(closers.size).toBe(0)
    expect(await it.next()).toStrictEqual({ value: undefined, done: true })
  })

  it('treats NONE as no value yet', async () => {
    const s = source<{ n: number | null }>({ n: null })
    const closers = new Set<() => void>()
    const it = iterate(() => s().n ?? NONE, closers, true)
    const first = it.next()
    s.publish({ n: 5 })
    flush()
    expect(await first).toStrictEqual({ value: 5, done: false })
    await it.return!()
  })

  it('a pull that throws ends iteration with that error, then done', async () => {
    const s = source<{ ok: boolean }>({ ok: true })
    const closers = new Set<() => void>()
    const it = iterate(() => {
      if (!s().ok) throw new Error('bad state')
      return 'fine'
    }, closers, true)
    expect(await it.next()).toStrictEqual({ value: 'fine', done: false })
    s.publish({ ok: false })
    flush()
    await expect(it.next()).rejects.toThrow('bad state')
    expect(closers.size).toBe(0)
    expect(await it.next()).toStrictEqual({ value: undefined, done: true })
  })

  it('a failure replaces a buffered value that was not yet taken', async () => {
    const s = source<{ n: number }>({ n: 1 })
    const it = iterate(() => {
      if (s().n > 1) throw new Error('too big')
      return s().n
    }, new Set(), true)
    s.publish({ n: 2 })
    flush()
    await expect(it.next()).rejects.toThrow('too big')
  })

  it('not live: pulls once, yields that value, then done', async () => {
    const closers = new Set<() => void>()
    const it = iterate(() => 'last', closers, false)
    expect(closers.size).toBe(0)
    expect(await it.next()).toStrictEqual({ value: 'last', done: false })
    expect(await it.next()).toStrictEqual({ value: undefined, done: true })
  })
})
