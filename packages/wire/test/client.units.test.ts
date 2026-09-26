// The client half's pure pieces as plain functions: entry keys, the lookup a
// row sends, the call id a raise rejects, the disconnected cast queue,
// WireError's message, and the redial backoff. connect() over a transport is
// covered end to end in wire.test.ts and wire.edges.test.ts.

import { describe, it, expect } from 'vitest'
import type { Json } from '@nonchalant/core'
import { CAST_QUEUE, entryKey, enqueue, lookupMsg, raisedCallId } from '../src/entry.ts'
import { WireError } from '../src/pump.ts'
import { redialDelay } from '../src/transports.ts'

describe('entryKey', () => {
  it('ignores object key order at every depth', () => {
    expect(entryKey('cart', { b: 1, a: { d: 2, c: 3 } })).toBe(entryKey('cart', { a: { c: 3, d: 2 }, b: 1 }))
    expect(entryKey('cart', { b: 1, a: 2 })).toBe('cart\0{"a":2,"b":1}')
  })

  it('keeps array order, since arrays are ordered values', () => {
    expect(entryKey('cart', [1, 2])).not.toBe(entryKey('cart', [2, 1]))
    expect(entryKey('cart', [{ b: 1, a: 2 }])).toBe('cart\0[{"a":2,"b":1}]')
  })

  it('tells no args apart from a null arg and from other names', () => {
    expect(entryKey('cart', undefined)).toBe('cart\0')
    expect(entryKey('cart', null)).toBe('cart\0null')
    expect(entryKey('cart', undefined)).not.toBe(entryKey('car', 't' as Json))
  })
})

describe('lookupMsg', () => {
  it('carries the protocol revision, and args only when there are some', () => {
    expect(lookupMsg({ ref: 's:1', name: 'cart', args: undefined })).toStrictEqual({ op: 'lookup', ref: 's:1', name: 'cart', v: 3 })
    expect(lookupMsg({ ref: 's:2', name: 'cart', args: { id: 1 } }))
      .toStrictEqual({ op: 'lookup', ref: 's:2', name: 'cart', v: 3, args: { id: 1 } })
    expect(lookupMsg({ ref: 's:3', name: 'cart', args: null })).toStrictEqual({ op: 'lookup', ref: 's:3', name: 'cart', v: 3, args: null })
  })
})

describe('raisedCallId', () => {
  it('reads a numeric id off an error object, including 0', () => {
    expect(raisedCallId({ message: 'no', id: 4 })).toBe(4)
    expect(raisedCallId({ id: 0 })).toBe(0)
  })

  it('treats anything else as a process-level raise', () => {
    const levels: Json[] = [{ message: 'crashed' }, { id: '4' }, 'boom', null, [4], 4]
    for (const err of levels) expect(raisedCallId(err)).toBeUndefined()
  })
})

describe('enqueue', () => {
  it('appends without touching the queue it was given', () => {
    const q: Json[] = [1]
    const next = enqueue(q, 2)
    expect(next).toStrictEqual([1, 2])
    expect(q).toStrictEqual([1])
  })

  it('keeps exactly the newest cap messages, in order', () => {
    let q: Json[] = []
    for (let i = 1; i <= 5; i++) q = enqueue(q, i, 3)
    expect(q).toStrictEqual([3, 4, 5])
  })

  it('defaults the cap to 64', () => {
    let q: Json[] = []
    for (let i = 0; i < 100; i++) q = enqueue(q, i)
    expect(CAST_QUEUE).toBe(64)
    expect(q).toHaveLength(64)
    expect(q[0]).toBe(36)
    expect(q[63]).toBe(99)
  })

  it('trims an over-full queue back to the cap', () => {
    expect(enqueue([1, 2, 3, 4], 5, 2)).toStrictEqual([4, 5])
  })
})

describe('WireError', () => {
  it('takes its message from a detail object, or stringifies any other detail', () => {
    const e = new WireError({ message: 'nope', id: 1 })
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('WireError')
    expect(e.message).toBe('nope')
    expect(e.detail).toStrictEqual({ message: 'nope', id: 1 })
    expect(new WireError('plain').message).toBe('plain')
    expect(new WireError({ message: 5 }).message).toBe('[object Object]')
    expect(new WireError(null).message).toBe('null')
  })
})

describe('redialDelay', () => {
  it('doubles per attempt from the base and stops growing at 8x', () => {
    expect([0, 1, 2, 3, 4, 10].map((n) => redialDelay(100, n, 1))).toStrictEqual([100, 200, 400, 800, 800, 800])
  })

  it('jitters into 50–100% of the step', () => {
    expect(redialDelay(100, 0, 0)).toBe(50)
    expect(redialDelay(100, 0, 0.5)).toBe(75)
    expect(redialDelay(100, 3, 0)).toBe(400)
  })
})
