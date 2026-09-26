// The keyed diff as plain data: matching old items to new entries, and the
// longest increasing subsequence that decides which reused nodes stay put.
// No DOM here; the property test in keyed.property.test.ts drives the same
// planner through real nodes.

import { describe, it, expect } from 'vitest'
import type { VNode } from '@nonchalant/core'
import { h } from '../src/h.ts'
import { keepers, match } from '../src/keyed.ts'
import type { Matchable } from '../src/keyed.ts'

const text: Matchable = { kind: 'text' }
const el = (vnode: VNode): Matchable => ({ kind: 'el', item: { vnode } })
const li = (key?: unknown): VNode => (key === undefined ? h('li') : h('li', { key }))

const run = (olds: Matchable[], flat: (string | VNode)[]): { from: number[]; used: boolean[] } => {
  const used: boolean[] = []
  return { from: match(olds, flat, used), used }
}

/** The indices of `from` that must be inserted, from last to first, as the region places them. */
const moved = (from: number[]): number[] => {
  const keep = keepers(from)
  const out: number[] = []
  for (let i = from.length - 1; i >= 0; i--) if (!keep[i]) out.push(i)
  return out
}

describe('match', () => {
  it('matches keyed elements by key regardless of position', () => {
    expect(run([el(li('a')), el(li('b')), el(li('c'))], [li('c'), li('a'), li('b')]).from).toEqual([2, 0, 1])
  })

  it('treats key 0 as a key: presence, not truthiness', () => {
    expect(run([el(li(1)), el(li(0))], [li(0), li(1)]).from).toEqual([1, 0])
  })

  it('marks new keys -1 and leaves dropped keys unused', () => {
    const { from, used } = run([el(li('a')), el(li('b'))], [li('b'), li('z')])
    expect(from).toEqual([1, -1])
    expect(used).toEqual([undefined, true])
  })

  it('matches unkeyed elements and text positionally', () => {
    expect(run([text, el(li()), text], ['x', li(), 'y']).from).toEqual([0, 1, 2])
  })

  it('appends past the old items when the new list is longer', () => {
    expect(run([text], ['x', 'y', 'z']).from).toEqual([0, -1, -1])
  })

  it('requires the same tag', () => {
    expect(run([el(h('li', { key: 1 }))], [h('p', { key: 1 })]).from).toEqual([-1])
    expect(run([el(h('li'))], [h('p')]).from).toEqual([-1])
  })

  it('never pairs a keyed old item with an unkeyed entry, or the reverse', () => {
    expect(run([el(li('a'))], [li()]).from).toEqual([-1])
    expect(run([el(li())], [li('a')]).from).toEqual([-1])
  })

  it('stops the positional cursor at an old item that does not match', () => {
    // the keyed old item blocks: the unkeyed entry does not reach the text behind it
    expect(run([el(li('a')), text], [li(), 'x']).from).toEqual([-1, -1])
    // text against an element: no match, and the element is still there for the next entry
    expect(run([el(li())], ['x', li()]).from).toEqual([-1, 0])
  })

  it('lets the cursor skip old items already taken by key', () => {
    expect(run([el(li('a')), text], [li('a'), 'x']).from).toEqual([0, 1])
  })

  it('matches each old item at most once when a key repeats', () => {
    expect(run([el(li('a'))], [li('a'), li('a')]).from).toEqual([0, -1])
  })

  it('matches the last old item when old keys repeat', () => {
    expect(run([el(li('a')), el(li('a'))], [li('a')]).from).toEqual([1])
  })

  it('matches nothing against an empty old list', () => {
    expect(run([], [li('a'), 'x']).from).toEqual([-1, -1])
  })
})

describe('keepers', () => {
  it('keeps everything when the order is unchanged', () => {
    expect(keepers([0, 1, 2, 3])).toEqual([true, true, true, true])
  })

  it('keeps nothing for all-new items', () => {
    expect(keepers([-1, -1])).toEqual([])
  })

  it('keeps nothing for an empty list', () => {
    expect(keepers([])).toEqual([])
  })

  it('keeps the survivors of a removal in place', () => {
    expect(keepers([0, 2, 3])).toEqual([true, true, true])
  })

  it('skips new items between kept ones', () => {
    expect(keepers([0, -1, 1])).toEqual([true, undefined, true])
  })

  it('keeps a single node when the list is reversed', () => {
    expect(keepers([3, 2, 1, 0]).filter(Boolean)).toHaveLength(1)
  })
})

describe('moves (keepers applied, last to first)', () => {
  it('a swap of two rows among many moves exactly two', () => {
    expect(moved([0, 8, 2, 3, 4, 5, 6, 7, 1, 9])).toEqual([8, 1])
  })

  it('moving the last row to the front moves exactly one', () => {
    expect(moved([4, 0, 1, 2, 3])).toEqual([0])
  })

  it('an append inserts only the new row', () => {
    expect(moved([0, 1, 2, -1])).toEqual([3])
  })

  it('a reversal of n moves n − 1', () => {
    expect(moved([3, 2, 1, 0])).toHaveLength(3)
  })

  it('an unchanged order moves nothing', () => {
    expect(moved([0, 1, 2])).toEqual([])
  })
})
