// The registry's pure pieces as plain functions: the cache-key encoder and
// the capacity policy.

import { describe, it, expect } from 'vitest'
import { keyEncoder } from '../src/key.ts'
import { evictionOrder } from '../src/registry.ts'

describe('keyEncoder', () => {
  const table: [string, unknown, string][] = [
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
    ['true', true, 'true'],
    ['false', false, 'false'],
    ['a string', 'a', 'string:"a"'],
    ['a string needing escapes', 'say "hi"\n', 'string:"say \\"hi\\"\\n"'],
    ['an integer', 1, 'number:1'],
    ['a fraction', 1.5, 'number:1.5'],
    ['0', 0, 'number:0'],
    ['-0', -0, 'number:-0'],
    ['NaN', Number.NaN, 'number:NaN'],
    ['Infinity', Number.POSITIVE_INFINITY, 'number:Infinity'],
    ['-Infinity', Number.NEGATIVE_INFINITY, 'number:-Infinity'],
    ['a bigint', 1n, 'bigint:1'],
    ['an empty array', [], 'array:[]'],
    ['an array', [1, 'a'], 'array:[number:1,string:"a"]'],
    ['an array with a hole', [, 1], 'array:[hole,number:1]'],
    ['an array holding undefined', [undefined, 1], 'array:[undefined,number:1]'],
    ['an empty record', {}, 'record:{}'],
    ['a record', { b: 2, a: 1 }, 'record:{"a":number:1,"b":number:2}'],
    ['a nested record', { a: { b: [true] } }, 'record:{"a":record:{"b":array:[true]}}'],
    ['a null-prototype record', Object.assign(Object.create(null) as object, { a: 1 }), 'record:{"a":number:1}'],
  ]
  for (const [label, value, key] of table) {
    it(`encodes ${label} as ${key}`, () => {
      expect(keyEncoder()(value)).toBe(key)
    })
  }

  it('sorts record keys, so property order never splits a key', () => {
    const key = keyEncoder()
    expect(key({ a: 1, b: { c: 1, d: 2 } })).toBe(key({ b: { d: 2, c: 1 }, a: 1 }))
  })

  it('encodes non-plain values by identity, stable per encoder', () => {
    const key = keyEncoder()
    const date = new Date(0)
    class Point { x = 1 }
    const fn = (): void => {}
    const sym = Symbol('s')
    expect(key(date)).toBe('object:1')
    expect(key(new Date(0))).toBe('object:2')
    expect(key(date)).toBe('object:1')
    expect(key(new Point())).toBe('object:3')
    expect(key(fn)).toBe('function:4')
    expect(key(sym)).toBe('symbol:5')
    expect(key([sym, fn])).toBe('array:[symbol:5,function:4]')
  })

  it('gives each encoder its own identity numbering', () => {
    const shared = new Map()
    const first = keyEncoder()
    first(new Map())
    expect(first(shared)).toBe('object:2')
    expect(keyEncoder()(shared)).toBe('object:1')
  })

  it('encodes a plain record carrying symbol keys by identity', () => {
    expect(keyEncoder()({ [Symbol('s')]: 1, a: 1 })).toBe('object:1')
  })

  it('encodes a cycle back-reference by identity and terminates', () => {
    const key = keyEncoder()
    const node: { next?: unknown } = {}
    node.next = node
    expect(key(node)).toBe('record:{"next":cycle:1}')
    const list: unknown[] = []
    list.push(list)
    expect(key(list)).toBe('array:[cycle:2]')
  })

  it('does not treat a repeated, non-cyclic reference as a cycle', () => {
    const leaf = { v: 1 }
    expect(keyEncoder()([leaf, leaf])).toBe('array:[record:{"v":number:1},record:{"v":number:1}]')
  })
})

type Row = { watchers: number; hooks: { busy?: () => boolean } }
const row = (watchers = 0, busy?: boolean): Row => ({ watchers, hooks: busy === undefined ? {} : { busy: () => busy } })

describe('evictionOrder', () => {
  it('offers unwatched, idle entries least recently looked up first', () => {
    const entries = new Map([['a', row()], ['b', row()], ['c', row()]])
    expect([...evictionOrder(entries, row())]).toStrictEqual(['a', 'b', 'c'])
  })

  it('never offers a watched entry, a busy entry, or the one to keep', () => {
    const keep = row()
    const entries = new Map([
      ['watched', row(2)],
      ['busy', row(0, true)],
      ['free', row(0, false)],
      ['keep', keep],
      ['last', row()],
    ])
    expect([...evictionOrder(entries, keep)]).toStrictEqual(['free', 'last'])
  })

  it('offers nothing when every entry is protected', () => {
    const keep = row()
    const entries = new Map([['w', row(1)], ['b', row(0, true)], ['k', keep]])
    expect([...evictionOrder(entries, keep)]).toStrictEqual([])
  })

  it('is lazy: it reads entries only as far as the caller pulls, and sees deletions', () => {
    let polled = 0
    const counted = (): Row => ({ watchers: 0, hooks: { busy: () => { polled++; return false } } })
    const entries = new Map([['a', counted()], ['b', counted()], ['c', counted()]])
    const order = evictionOrder(entries, row())
    expect(order.next().value).toBe('a')
    expect(polled).toBe(1)
    entries.delete('b')
    expect(order.next().value).toBe('c')
    expect(polled).toBe(2)
  })
})
