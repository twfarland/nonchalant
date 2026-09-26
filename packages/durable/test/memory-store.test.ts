// The reference adapter's pure parts: which keys are due, and which answers
// the retention window keeps.

import { describe, it, expect } from 'vitest'
import { dueKeys, retained } from '../src/memory-store.ts'

describe('dueKeys', () => {
  it('picks keys whose wake is at or before the time, earliest first', () => {
    expect(dueKeys([['c', 300], ['a', 100], ['late', 301], ['b', 200]], 300, 10)).toStrictEqual(['a', 'b', 'c'])
  })

  it('never picks a key with no wake time', () => {
    expect(dueKeys([['none', undefined], ['k', 0]], Number.MAX_SAFE_INTEGER, 10)).toStrictEqual(['k'])
  })

  it('stops at the limit, keeping the earliest', () => {
    expect(dueKeys([['c', 3], ['a', 1], ['b', 2]], 10, 2)).toStrictEqual(['a', 'b'])
    expect(dueKeys([['a', 1]], 10, 0)).toStrictEqual([])
  })

  it('keeps the given order among equal wake times', () => {
    expect(dueKeys([['y', 5], ['x', 5], ['w', 4]], 5, 10)).toStrictEqual(['w', 'y', 'x'])
  })

  it('reads a Map of wake times as it is', () => {
    expect(dueKeys(new Map([['k', 1], ['j', 2]]), 1, 10)).toStrictEqual(['k'])
  })
})

describe('retained', () => {
  it('keeps answers committed at or after the cutoff and forgets the rest', () => {
    const results = new Map([['old', ['a', 49] as const], ['edge', ['b', 50] as const], ['new', ['c', 51] as const]])
    expect([...retained(results, 50)]).toStrictEqual([['edge', ['b', 50]], ['new', ['c', 51]]])
  })

  it('leaves the map it was given untouched', () => {
    const results = new Map([['old', [1, 0] as const]])
    retained(results, 10)
    expect(results.size).toBe(1)
  })
})
