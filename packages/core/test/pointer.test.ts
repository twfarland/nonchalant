import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { arrayIndex, escapeSegment, parsePath, unescapeSegment } from '../src/pointer.ts'

describe('escapeSegment', () => {
  it.each([
    ['plain', 'plain'],
    ['', ''],
    ['a/b', 'a~1b'],
    ['~', '~0'],
    ['~1', '~01'],
    ['/~', '~1~0'],
  ])('encodes %j as %j', (raw, encoded) => {
    expect(escapeSegment(raw)).toBe(encoded)
  })

  it('returns a segment with nothing to escape as the same string', () => {
    const k = 'items'
    expect(escapeSegment(k)).toBe(k)
  })
})

describe('unescapeSegment', () => {
  it.each([
    ['a~1b', 'a/b'],
    ['~0', '~'],
    ['~01', '~1'],
    ['~10', '/0'],
    ['plain', 'plain'],
  ])('decodes %j as %j', (encoded, raw) => {
    expect(unescapeSegment(encoded)).toBe(raw)
  })

  it.each(['~', '~2', 'a~', '~~0'])('rejects the invalid escape in %j', (s) => {
    expect(() => unescapeSegment(s)).toThrow(/invalid escape/)
  })

  it('inverts escapeSegment for every string', () => {
    fc.assert(fc.property(fc.string(), (k) => unescapeSegment(escapeSegment(k)) === k))
  })
})

describe('parsePath', () => {
  it('reads the root as no segments', () => {
    expect(parsePath('')).toEqual([])
  })

  it.each([
    ['/', ['']],
    ['/a', ['a']],
    ['/items/3/done', ['items', '3', 'done']],
    ['/a~1b/~0', ['a/b', '~']],
    ['//', ['', '']],
  ])('splits %j into %j', (path, segs) => {
    expect(parsePath(path)).toEqual(segs)
  })

  it('rejects a pointer without a leading slash', () => {
    expect(() => parsePath('a/b')).toThrow(/must start with "\/"/)
  })

  it('rejects a pointer with a bad escape in any segment', () => {
    expect(() => parsePath('/ok/~2')).toThrow(/invalid escape/)
  })
})

describe('arrayIndex (the RFC 6901 index rule)', () => {
  it.each([
    ['0', 1, 0],
    ['9', 10, 9],
    ['10', 11, 10],
  ])('reads %j in an array of %i as %i', (k, length, idx) => {
    expect(arrayIndex(k, length)).toBe(idx)
  })

  it.each(['01', '1e0', ' 1', '1 ', '', '-', '-1', '+1', '0x1', '1.0'])('rejects %j, which Number() would mostly accept', (k) => {
    expect(() => arrayIndex(k, 100)).toThrow(/bad array index/)
  })

  it('rejects an index at or past the end', () => {
    expect(() => arrayIndex('3', 3)).toThrow(/bad array index "3"/)
    expect(() => arrayIndex('0', 0)).toThrow(/bad array index/)
  })
})
