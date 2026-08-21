import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { reconcile, applyPatch, type Json } from '../src/reconcile.ts'

// Wire-safe keys until RFC 6901 escaping lands (see reconcile.ts TODO).
const key = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,6}$/)

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

  it('root type changes are a single root set', () => {
    expect(reconcile({ a: 1 }, [1])).toStrictEqual([['set', '', [1]]])
  })

  it('rejects prototype-polluting paths', () => {
    expect(() => applyPatch({}, [['set', '/__proto__/x', 1]])).toThrow(/illegal path/)
    expect(() => applyPatch({}, [['set', '/constructor', 1]])).toThrow(/illegal path/)
    expect(({} as Record<string, unknown>)['x']).toBeUndefined()
  })

  it('rejects keys needing RFC 6901 escaping (until implemented)', () => {
    expect(() => reconcile({}, { 'a/b': 1 })).toThrow(/RFC 6901/)
  })
})
