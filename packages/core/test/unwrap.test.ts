import { describe, it, expect } from 'vitest'
import { createRecorder } from '../src/track.ts'
import { isTrackable, unproxy, unwrap } from '../src/unwrap.ts'
import type { Json } from '../src/reconcile.ts'

type State = { meta: { tag: string }; items: { n: number }[] }

/** A snapshot, and a live read proxy over it from an open recorder. */
function proxied(): { raw: State; s: State; done: () => void } {
  const raw: State = { meta: { tag: 'x' }, items: [{ n: 0 }, { n: 1 }] }
  const r = createRecorder()
  return { raw, s: r.wrap(raw as unknown as Json) as unknown as State, done: () => void r.finalize() }
}

/** A plain-prototyped object whose key enumerations are counted: each is one walk. */
function counted<T extends object>(target: T): { value: T; walks: () => number } {
  let walks = 0
  const value = new Proxy(target, {
    ownKeys: (t) => {
      walks++
      return Reflect.ownKeys(t)
    },
  })
  return { value, walks: () => walks }
}

describe('isTrackable', () => {
  it.each([
    [[], true],
    [{}, true],
    [Object.create(null), true],
    [new Date(0), false],
    [new Map(), false],
    [new (class Box {})(), false],
  ])('%o: %s', (v, expected) => {
    expect(isTrackable(v)).toBe(expected)
  })
})

describe('unproxy', () => {
  it('swaps a read proxy for its raw target and passes everything else through', () => {
    const { raw, s, done } = proxied()
    expect(unproxy(s)).toBe(raw)
    expect(unproxy(s.meta)).toBe(raw.meta)
    const plain = { a: 1 }
    expect(unproxy(plain)).toBe(plain)
    expect(unproxy(5)).toBe(5)
    expect(unproxy(null)).toBe(null)
    expect(unproxy(undefined)).toBe(undefined)
    done()
  })

  it('does not look inside a container', () => {
    const { s, done } = proxied()
    const holder = { meta: s.meta }
    expect(unproxy(holder).meta).toBe(s.meta)
    done()
  })

  it('still swaps a proxy whose run has ended', () => {
    const { raw, s, done } = proxied()
    done()
    expect(unproxy(s)).toBe(raw)
  })
})

describe('unwrap', () => {
  it('swaps proxies at any depth, patching the plain containers around them in place', () => {
    const { raw, s, done } = proxied()
    const result = { first: s.items[0], nested: [{ meta: s.meta }], n: 1 }
    const inner = result.nested[0]
    expect(unwrap(result)).toBe(result)
    expect(result.first).toBe(raw.items[0])
    expect(result.nested[0]).toBe(inner)
    expect(inner!.meta).toBe(raw.meta)
    done()
  })

  it('leaves a proxy inside a frozen container or a non-plain object', () => {
    const { s, done } = proxied()
    const frozen = Object.freeze({ meta: s.meta })
    const map = new Map([['meta', s.meta]])
    unwrap({ frozen, map })
    expect(frozen.meta).toBe(s.meta)
    expect(map.get('meta')).toBe(s.meta)
    done()
  })

  it('terminates on a cycle', () => {
    const { raw, s, done } = proxied()
    const node: { self?: unknown; meta: unknown } = { meta: s.meta }
    node.self = node
    expect(unwrap(node)).toBe(node)
    expect(node.meta).toBe(raw.meta)
    done()
  })

  it('walks a proxy-free container once, however often it is unwrapped', () => {
    const table = counted({ rows: [{ id: 1 }, { id: 2 }] })
    unwrap({ table: table.value })
    unwrap({ table: table.value })
    unwrap(table.value)
    expect(table.walks()).toBe(1)
  })

  it('walks a container that held a proxy again on every unwrap, so a refill is swapped too', () => {
    const box = counted<{ cur?: unknown }>({})
    const a = proxied()
    box.value.cur = a.s.meta
    unwrap(box.value)
    expect(box.value.cur).toBe(a.raw.meta)
    a.done()
    const b = proxied()
    box.value.cur = b.s.meta
    unwrap(box.value)
    expect(box.value.cur).toBe(b.raw.meta)
    b.done()
    expect(box.walks()).toBe(2)
  })

  it('walks the ancestors of a container that held a proxy again too', () => {
    const outer = counted<{ inner: { cur?: unknown } }>({ inner: {} })
    const a = proxied()
    outer.value.inner.cur = a.s.meta
    unwrap(outer.value)
    const b = proxied()
    outer.value.inner.cur = b.s.meta
    unwrap(outer.value)
    expect(outer.value.inner.cur).toBe(b.raw.meta)
    expect(outer.walks()).toBe(2)
    a.done()
    b.done()
  })

  it('the documented limit: a container found proxy-free, then mutated to hold one, is not walked again', () => {
    const box: { cur?: unknown } = {}
    unwrap(box)
    const { s, done } = proxied()
    box.cur = s.meta
    unwrap(box)
    expect(box.cur).toBe(s.meta)
    done()
  })
})
