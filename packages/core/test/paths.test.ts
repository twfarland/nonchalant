// The patch matcher over hand-built trees: each case names what a run read
// and which ops must wake it. graph.test.ts drives the same rules through
// real recorders; here the tree is the whole input.

import { describe, it, expect } from 'vitest'
import { affects, hasDep, opAffects, readsFrom, type PathTree } from '../src/paths.ts'
import { parsePath } from '../src/pointer.ts'
import type { Op } from '../src/reconcile.ts'

type Flags = Partial<Omit<PathTree, 'children'>>

const t = (flags: Flags = {}, kids?: { [key: string]: PathTree }): PathTree => ({
  children: kids === undefined ? null : new Map(Object.entries(kids)),
  leaf: false,
  structural: false,
  array: false,
  traversed: false,
  subtree: false,
  ...flags,
})

const wakes = (tree: PathTree, op: Op): boolean => opAffects(tree, op, parsePath(op[1]))

// read s.items[2].done and s.total
const rowReader = t({ traversed: true }, {
  items: t({ traversed: true, array: true }, { 2: t({ traversed: true }, { done: t({ leaf: true }) }) }),
  total: t({ leaf: true }),
})

describe('opAffects: set and del', () => {
  it.each<[string, Op, boolean]>([
    ['the exact leaf read', ['set', '/total', 1], true],
    ['beneath a leaf read (shape drift)', ['set', '/total/x', 1], true],
    ['the exact nested leaf', ['set', '/items/2/done', true], true],
    ['a sibling row', ['set', '/items/1/done', true], false],
    ['a sibling key of the row', ['set', '/items/2/n', 1], false],
    ['an unread top-level key', ['set', '/meta', {}], false],
    ['an ancestor of the read (replaced whole)', ['set', '/items', []], true],
    ['the root', ['set', '', null], true],
    ['a del of the read row', ['del', '/items/2'], true],
    ['a del of an unread row', ['del', '/items/3'], false],
  ])('%s: %j wakes = %s', (_, op, expected) => {
    expect(wakes(rowReader, op)).toBe(expected)
  })

  it('a subtree dependency wakes for any op at or beneath it', () => {
    const escaped = t({ traversed: true }, { meta: t({ traversed: true, subtree: true }) })
    expect(wakes(escaped, ['set', '/meta/deep/er', 1])).toBe(true)
    expect(wakes(escaped, ['del', '/meta/tag'])).toBe(true)
    expect(wakes(escaped, ['set', '/other', 1])).toBe(false)
  })

  it('a structural record node wakes for a set or del of any direct key', () => {
    const keys = t({ traversed: true }, { meta: t({ traversed: true, structural: true }) })
    expect(wakes(keys, ['set', '/meta/added', 1])).toBe(true)
    expect(wakes(keys, ['del', '/meta/tag'])).toBe(true)
    expect(wakes(keys, ['set', '/meta/tag/deeper', 1])).toBe(false)
  })

  it('a structural array node sleeps through an element set, which is never a length change', () => {
    const len = t({ traversed: true }, { items: t({ traversed: true, structural: true, array: true }) })
    expect(wakes(len, ['set', '/items/0', 1])).toBe(false)
    expect(wakes(len, ['del', '/items/0'])).toBe(true)
  })

  it('an array del is a one-element splice: a later index wakes, an earlier one sleeps', () => {
    // read items[4] only (no length): the del at 2 shifts it
    const row4 = t({ traversed: true }, { items: t({ traversed: true, array: true }, { 4: t({ leaf: true }) }) })
    expect(wakes(row4, ['del', '/items/2'])).toBe(true)
    expect(wakes(row4, ['del', '/items/5'])).toBe(false)
    expect(wakes(row4, ['set', '/items/2', 'x'])).toBe(false)
  })

  it('a bare presence node wakes for a set or del of that key only', () => {
    const presence = t({ traversed: true }, { meta: t({ traversed: true }, { tag: t() }) })
    expect(wakes(presence, ['set', '/meta/tag', 'y'])).toBe(true)
    expect(wakes(presence, ['del', '/meta/tag'])).toBe(true)
    expect(wakes(presence, ['set', '/meta/tag/x', 1])).toBe(false)
  })
})

describe('opAffects: splice', () => {
  it.each<[string, number, boolean]>([
    ['before the read row', 1, true],
    ['at the read row', 2, true],
    ['after the read row', 3, false],
  ])('a splice %s wakes = %s', (_, start, expected) => {
    expect(wakes(rowReader, ['splice', '/items', start, 0, [null]])).toBe(expected)
  })

  it('a splice on an array whose length was read always wakes', () => {
    const len = t({ traversed: true }, { items: t({ traversed: true, structural: true, array: true }) })
    expect(wakes(len, ['splice', '/items', 99, 0, [null]])).toBe(true)
  })

  it('a splice on an unread array sleeps', () => {
    expect(wakes(rowReader, ['splice', '/others', 0, 0, [null]])).toBe(false)
  })

  it('a splice inside a leaf-read path wakes', () => {
    expect(wakes(rowReader, ['splice', '/total/list', 0, 0, [null]])).toBe(true)
  })
})

describe('affects', () => {
  it('wakes when any one op intersects, and parses paths itself when none are given', () => {
    expect(affects(rowReader, [['set', '/meta', 1], ['set', '/total', 2]])).toBe(true)
    expect(affects(rowReader, [['set', '/meta', 1], ['set', '/items/0/done', true]])).toBe(false)
    expect(affects(rowReader, [])).toBe(false)
  })

  it('uses the pre-parsed segments it is handed instead of the op paths', () => {
    // the op says /meta, the handed segments say /total: the segments win
    expect(affects(rowReader, [['set', '/meta', 1]], [['total']])).toBe(true)
  })
})

describe('readsFrom', () => {
  it('finds a read index at or after the start, ignoring non-index keys', () => {
    const tree = t({ array: true }, { 0: t({ leaf: true }), 4: t({ leaf: true }), length: t() })
    expect(readsFrom(tree, 4)).toBe(true)
    expect(readsFrom(tree, 0)).toBe(true)
    expect(readsFrom(tree, 5)).toBe(false)
    expect(readsFrom(t({ array: true }), 0)).toBe(false)
  })
})

describe('hasDep', () => {
  it.each<[string, PathTree, boolean]>([
    ['nothing', t(), false],
    ['a leaf', t({ leaf: true }), true],
    ['a structural read', t({ structural: true }), true],
    ['a subtree', t({ subtree: true }), true],
    ['a traversal', t({ traversed: true }), true],
    ['a child', t({}, { k: t() }), true],
    ['an empty child map', { ...t(), children: new Map() }, false],
  ])('%s: %s', (_, tree, expected) => {
    expect(hasDep(tree)).toBe(expected)
  })
})
