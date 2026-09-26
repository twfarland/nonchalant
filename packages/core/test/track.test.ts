// The recorder's output: scripted reads through a recorder's proxy, and the
// PathTree finalize() distils from them. Trees are flattened to the set of
// recorded paths with their flags, so each case states exactly what it read.

import { describe, it, expect } from 'vitest'
import { createRecorder, handed, isPinned } from '../src/track.ts'
import type { PathTree } from '../src/paths.ts'
import type { Json } from '../src/reconcile.ts'

type State = { items: { done: boolean; n: number }[]; total: number; meta: { tag: string } }

const mkState = (): State => ({
  items: [{ done: false, n: 0 }, { done: true, n: 1 }, { done: false, n: 2 }],
  total: 3,
  meta: { tag: 'x' },
})

/** Every recorded path, with the flags set there ('' when a bare node). */
function flatten(tree: PathTree, path = ''): { [path: string]: string } {
  const flags = (['leaf', 'structural', 'array', 'traversed', 'subtree'] as const).filter((f) => tree[f]).join(' ')
  const out: { [path: string]: string } = { [path === '' ? '/' : path]: flags }
  if (tree.children !== null) for (const [k, c] of tree.children) Object.assign(out, flatten(c, `${path}/${k}`))
  return out
}

function record(read: (s: State) => unknown, state: State = mkState()): { [path: string]: string } {
  const r = createRecorder()
  read(r.wrap(state as unknown as Json) as unknown as State)
  return flatten(r.finalize())
}

describe('the path tree a run records', () => {
  it('a primitive read records a leaf and traversals above it', () => {
    expect(record((s) => s.items[1]!.done)).toEqual({
      '/': 'traversed',
      '/items': 'array traversed',
      '/items/1': 'traversed',
      '/items/1/done': 'leaf',
    })
  })

  it('a container obtained and never read into is promoted to a subtree', () => {
    expect(record((s) => s.meta)).toEqual({ '/': 'traversed', '/meta': 'traversed subtree' })
  })

  it('a container both read into and escaped records as traversal only (the documented approximation)', () => {
    expect(record((s) => [s.items, s.items[0]!.n])).toEqual({
      '/': 'traversed',
      '/items': 'array traversed',
      '/items/0': 'traversed',
      '/items/0/n': 'leaf',
    })
  })

  it('an absent key records a leaf at that key', () => {
    expect(record((s) => (s as { maybe?: number }).maybe)).toEqual({ '/': 'traversed', '/maybe': 'leaf' })
  })

  it('an array length read is structural', () => {
    expect(record((s) => s.items.length)).toEqual({ '/': 'traversed', '/items': 'structural array traversed' })
  })

  it('key enumeration is structural with a bare presence node per key, not a leaf per value', () => {
    expect(record((s) => Object.keys(s.meta))).toEqual({
      '/': 'traversed',
      '/meta': 'structural traversed',
      '/meta/tag': '',
    })
  })

  it('`in` and Object.hasOwn record bare presence nodes', () => {
    expect(record((s) => ['total' in s, Object.hasOwn(s.meta, 'gone')])).toEqual({
      '/': 'traversed',
      '/total': '',
      '/meta': 'traversed',
      '/meta/gone': '',
    })
  })

  it('a prototype method passes through and its own element reads are recorded', () => {
    expect(record((s) => s.items.map((x) => x.n))).toEqual({
      '/': 'traversed',
      '/items': 'structural array traversed',
      '/items/0': 'traversed',
      '/items/0/n': 'leaf',
      '/items/1': 'traversed',
      '/items/1/n': 'leaf',
      '/items/2': 'traversed',
      '/items/2/n': 'leaf',
    })
  })

  it('a frozen nested container is a coarse subtree dependency, handed back raw', () => {
    const meta = Object.freeze({ tag: 'x' })
    const state = Object.freeze({ ...mkState(), meta })
    let got: unknown
    expect(record((s) => (got = s.meta), state)).toEqual({ '/': 'traversed', '/meta': 'traversed subtree' })
    expect(got).toBe(meta)
  })

  it('a run that reads nothing records only the root it was handed', () => {
    expect(record(() => undefined)).toEqual({ '/': 'traversed subtree' })
  })

  it('a primitive snapshot records a leaf at the root', () => {
    const r = createRecorder()
    expect(r.wrap(5)).toBe(5)
    expect(flatten(r.finalize())).toEqual({ '/': 'leaf' })
  })

  it('a non-plain object is handed back as-is and recorded as a leaf', () => {
    const r = createRecorder()
    const when = new Date(0)
    const s = r.wrap({ when } as unknown as Json) as unknown as { when: Date }
    expect(s.when).toBe(when)
    expect(flatten(r.finalize())['/when']).toBe('leaf')
  })
})

describe('proxy lifetime', () => {
  it('one container read twice in a run is one proxy', () => {
    const r = createRecorder()
    const s = r.wrap(mkState() as unknown as Json) as unknown as State
    expect(s.meta).toBe(s.meta)
    r.finalize()
  })

  it('every container handed out moves the handed counter, reuse included', () => {
    const r = createRecorder()
    const before = handed
    const s = r.wrap(mkState() as unknown as Json) as unknown as State
    void s.meta
    void s.meta
    void s.total
    expect(handed - before).toBe(3)
    r.finalize()
  })

  it('after finalize a proxy hands out raw values and records nothing', () => {
    const state = mkState()
    const r = createRecorder()
    const s = r.wrap(state as unknown as Json) as unknown as State
    void s.total
    const tree = r.finalize()
    expect(s.meta).toBe(state.meta)
    expect(Object.keys(s)).toEqual(['items', 'total', 'meta'])
    expect('meta' in s).toBe(true)
    expect(flatten(tree)).toEqual({ '/': 'traversed', '/total': 'leaf' })
  })

  it('a stale proxy stays read-only', () => {
    const r = createRecorder()
    const s = r.wrap(mkState() as unknown as Json) as unknown as State
    r.finalize()
    expect(() => {
      s.total = 1
    }).toThrow(/read-only/)
    expect(() => delete (s as { total?: number }).total).toThrow(/read-only/)
    expect(() => Object.setPrototypeOf(s, null)).toThrow(/read-only/)
    expect(() => Object.defineProperty(s, 'x', { value: 1 })).toThrow(/read-only/)
  })
})

describe('isPinned', () => {
  it('is true only for a non-configurable, non-writable data property', () => {
    const o = Object.freeze({ a: 1 })
    expect(isPinned(o, 'a')).toBe(true)
    expect(isPinned({ a: 1 }, 'a')).toBe(false)
    expect(isPinned(Object.defineProperty({}, 'a', { value: 1, writable: false, configurable: true }), 'a')).toBe(false)
    expect(isPinned(Object.defineProperty({}, 'a', { value: 1, writable: true, configurable: false }), 'a')).toBe(false)
    expect(isPinned(Object.defineProperty({}, 'a', { get: () => 1, configurable: false }), 'a')).toBe(false)
    expect(isPinned({}, 'missing')).toBe(false)
  })
})
