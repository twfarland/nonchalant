import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { reconcile, applyPatch, type Json } from '../src/reconcile.ts'

// Every JSON object key is wire-safe; patch application defines own properties
// without invoking Object.prototype setters.
const key = fc
  .oneof(fc.string({ maxLength: 8 }), fc.constantFrom('a/b', '~', '~0', '~1', 'a~/b', '/', ''))

const { json } = fc.letrec<{ json: Json }>((tie) => ({
  json: fc.oneof(
    { maxDepth: 4, withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.string(),
    fc.array(tie('json'), { maxLength: 6 }),
    fc.dictionary(key, tie('json'), { maxKeys: 6 }).map((d) => ({ ...d })), // plain prototypes: wire JSON has no prototype notion
  ),
}))

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}

describe('reconcile / applyPatch', () => {
  it('round-trips: applyPatch(prev, reconcile(prev, next)) equals next', () => {
    fc.assert(
      fc.property(json, json, (prev, next) => {
        const patch = reconcile(prev, next)
        expect(applyPatch(prev, patch)).toStrictEqual(next)
      }),
      { numRuns: 500 },
    )
  })

  it('never mutates its inputs', () => {
    fc.assert(
      fc.property(json, json, (prev, next) => {
        deepFreeze(prev)
        const patch = reconcile(prev, next)
        applyPatch(prev, patch) // throws in strict mode if anything writes to prev
      }),
      { numRuns: 200 },
    )
  })

  it('identity yields an empty patch', () => {
    const v: Json = { a: [1, { b: 'c' }], d: null }
    expect(reconcile(v, v)).toStrictEqual([])
  })

  it('structural sharing short-circuits: one change in 1000 emits one op', () => {
    const prev: Json = Array.from({ length: 1000 }, (_, i) => ({ id: i, done: false }))
    const next = (prev as Json[]).map((x, i) => (i === 500 ? { id: 500, done: true } : x))
    const patch = reconcile(prev, next)
    expect(patch).toStrictEqual([['set', '/500/done', true]])
  })

  it('append and truncate become splices', () => {
    expect(reconcile([1, 2], [1, 2, 3])).toStrictEqual([['splice', '', 2, 0, [3]]])
    expect(reconcile([1, 2, 3], [1])).toStrictEqual([['splice', '', 1, 2, []]])
  })

  it('mid-array insert becomes a single splice', () => {
    const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' }, x = { id: 'x' }, y = { id: 'y' }
    expect(reconcile([a, b, c], [a, x, y, b, c])).toStrictEqual([['splice', '', 1, 0, [x, y]]])
  })

  it('mid-array removal becomes a single splice', () => {
    const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' }, d = { id: 'd' }
    expect(reconcile([a, b, c, d], [a, d])).toStrictEqual([['splice', '', 1, 2, []]])
  })

  it('minimality: any contiguous insert of shared-identity neighbours is exactly one op', () => {
    fc.assert(
      fc.property(
        fc.array(json, { maxLength: 8 }),
        fc.array(json, { minLength: 1, maxLength: 4 }),
        fc.nat(8),
        (base, inserted, posSeed) => {
          const pos = base.length === 0 ? 0 : posSeed % (base.length + 1)
          const next = [...base.slice(0, pos), ...inserted, ...base.slice(pos)]
          const patch = reconcile(base, next)
          expect(patch).toHaveLength(1)
          expect(patch[0]?.[0]).toBe('splice')
          expect(applyPatch(base, patch)).toStrictEqual(next)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('minimality: any contiguous removal is exactly one op', () => {
    fc.assert(
      fc.property(fc.array(json, { minLength: 1, maxLength: 8 }), fc.nat(8), fc.nat(8), (base, posSeed, lenSeed) => {
        const pos = posSeed % base.length
        const count = 1 + (lenSeed % (base.length - pos))
        const next = [...base.slice(0, pos), ...base.slice(pos + count)]
        const patch = reconcile(base, next)
        expect(patch).toHaveLength(1)
        expect(patch[0]?.[0]).toBe('splice')
        expect(applyPatch(base, patch)).toStrictEqual(next)
      }),
      { numRuns: 300 },
    )
  })

  it('one changed element between shared neighbours stays a scoped set, not a splice', () => {
    const a = { id: 'a' }, b = { id: 'b', done: false }, c = { id: 'c' }
    expect(reconcile([a, b, c], [a, { id: 'b', done: true }, c])).toStrictEqual([['set', '/1/done', true]])
  })

  it('root type changes are a single root set', () => {
    expect(reconcile({ a: 1 }, [1])).toStrictEqual([['set', '', [1]]])
  })

  it('keys that shadow Object.prototype diff by own-ness, not `in`', () => {
    // found by the round-trip property (seed 1880411877): `'toString' in {}`
    // is true via the prototype chain, which used to swallow the deletion
    expect(reconcile({ toString: null }, {})).toStrictEqual([['del', '/toString']])
    expect(applyPatch({ toString: null, keep: 1 }, [['del', '/toString']])).toStrictEqual({ keep: 1 })
    expect(reconcile({}, { valueOf: 7 })).toStrictEqual([['set', '/valueOf', 7]])
    expect(applyPatch({}, [['set', '/valueOf', 7]])).toStrictEqual({ valueOf: 7 })
  })

  it('round-trips reserved-looking keys without prototype pollution', () => {
    const next = JSON.parse('{"__proto__":{"x":1},"constructor":2,"prototype":3}') as Json
    const applied = applyPatch({}, reconcile({}, next)) as Record<string, Json>
    expect(applied).toStrictEqual(next)
    expect(Object.hasOwn(applied, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>)['x']).toBeUndefined()
  })

  it('rejects malformed array indices and splice ranges', () => {
    expect(() => applyPatch([1], [['del', '/1']])).toThrow(/bad array index/)
    expect(() => applyPatch([1], [['set', '/1', 2]])).toThrow(/bad array index/)
    expect(() => applyPatch([1], [['splice', '', -1, 0, []]])).toThrow(/bad splice/)
    expect(() => applyPatch([1], [['splice', '', 0.5, 0, []]])).toThrow(/bad splice/)
    expect(() => applyPatch([1], [['splice', '', 0, 2, []]])).toThrow(/bad splice/)
  })

  it('escapes RFC 6901 special characters in keys', () => {
    expect(reconcile({}, { 'a/b': 1 })).toStrictEqual([['set', '/a~1b', 1]])
    expect(reconcile({}, { '~': 1 })).toStrictEqual([['set', '/~0', 1]])
    expect(reconcile({ 'm~n': { 'x/y': 0 } }, { 'm~n': { 'x/y': 1 } })).toStrictEqual([
      ['set', '/m~0n/x~1y', 1],
    ])
    // '~01' must decode to the literal key '~1', not to '/'
    expect(reconcile({ '~1': 0 }, {})).toStrictEqual([['del', '/~01']])
    expect(applyPatch({ '~1': 0, keep: true }, [['del', '/~01']])).toStrictEqual({ keep: true })
  })

  it('rejects malformed escape sequences in paths', () => {
    expect(() => applyPatch({}, [['set', '/a~2b', 1]])).toThrow(/invalid escape/)
    expect(() => applyPatch({}, [['set', '/a~', 1]])).toThrow(/invalid escape/)
  })
})
