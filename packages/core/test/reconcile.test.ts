import { describe, it, expect, vi } from 'vitest'
import fc from 'fast-check'
import { reconcile, applyPatch, isRecord, type Json, type Patch } from '../src/reconcile.ts'

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

  it('a key holding undefined is absent: never added, and going to undefined is a del', () => {
    const undef = undefined as unknown as Json
    expect(reconcile({}, { a: undef })).toStrictEqual([])
    expect(reconcile({ a: 1 }, { a: undef })).toStrictEqual([['del', '/a']])
    expect(reconcile({ a: undef }, { a: 1 })).toStrictEqual([['set', '/a', 1]])
    expect(reconcile({ a: undef }, {})).toStrictEqual([])
    expect(applyPatch({ a: 1, b: 2 }, [['set', '/a', undef]])).toStrictEqual({ b: 2 })
    expect(applyPatch({ b: 2 }, [['set', '/a', undef]])).toStrictEqual({ b: 2 })
  })

  it('round-trips records carrying undefined values, up to undefined-means-absent', () => {
    const rec = fc.dictionary(key, fc.oneof(fc.constant(undefined), fc.integer()), { maxKeys: 6 }).map((d) => ({ ...d }))
    const defined = (r: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined))
    fc.assert(
      fc.property(rec, rec, (prev, next) => {
        const applied = applyPatch(prev as Json, reconcile(prev as Json, next as Json)) as Record<string, unknown>
        expect(defined(applied)).toStrictEqual(defined(next))
        expect(Object.keys(applied).filter((k) => applied[k] === undefined)).toStrictEqual(
          Object.keys(prev).filter((k) => prev[k] === undefined && !Object.hasOwn(defined(next), k)),
        )
      }),
      { numRuns: 300 },
    )
  })

  it('array indices follow the RFC 6901 grammar exactly', () => {
    for (const bad of ['', ' ', '01', '1e0', '+1', '-', '-0', '0x1', '1.0', ' 1', '1 ']) {
      expect(() => applyPatch([1, 2], [['set', `/${bad}`, 9]])).toThrow(/bad array index/)
      expect(() => applyPatch([1, 2], [['del', `/${bad}`]])).toThrow(/bad array index/)
    }
    expect(applyPatch([1, 2], [['set', '/0', 9]])).toStrictEqual([9, 2])
    expect(applyPatch([1, 2], [['set', '/1', 9]])).toStrictEqual([1, 9])
  })

  it('rejects ops whose target cannot hold them', () => {
    expect(() => applyPatch({ a: 1 }, [['splice', '', 0, 0, []]])).toThrow(/splice target is not an array/)
    expect(() => applyPatch({ a: 1 }, [['splice', '/a', 0, 0, []]])).toThrow(/splice target is not an array/)
    expect(() => applyPatch({ a: 1 }, [['del', '']])).toThrow(/cannot del the root/)
    expect(() => applyPatch({ a: 1 }, [['set', '/a/b', 2]])).toThrow(/non-container/)
    expect(() => applyPatch({ a: 1 }, [['set', '/x/y', 2]])).toThrow(/missing path segment/)
    expect(() => applyPatch({ a: 1 }, [['del', '/x']])).toThrow(/missing path segment/)
    expect(() => applyPatch([[1]], [['set', '/0/5', 2]])).toThrow(/bad array index/)
  })

  it('applies several patches as one: the result matches, and neither the input nor the patch is written', () => {
    fc.assert(
      fc.property(json, json, json, (prev, mid, next) => {
        const patch = [...reconcile(prev, mid), ...reconcile(mid, next)]
        deepFreeze(prev)
        deepFreeze(patch as unknown as Json)
        expect(applyPatch(prev, patch)).toStrictEqual(next)
      }),
      { numRuns: 300 },
    )
  })

  it('an op that descends into a value an earlier op set copies it rather than writing the patch', () => {
    const inserted = deepFreeze({ n: 1 }) as Json
    const patch: Patch = [['set', '/a', inserted], ['set', '/a/n', 2]]
    expect(applyPatch({ a: null }, patch)).toStrictEqual({ a: { n: 2 } })
    expect(inserted).toStrictEqual({ n: 1 })
  })

  it('copies each container once per patch: reversing 1,000 rows copies the array once', () => {
    const prev = Array.from({ length: 1000 }, (_, i) => ({ id: i }))
    const patch = reconcile(prev, prev.toReversed())
    expect(patch.length).toBe(1000)
    const slice = vi.spyOn(Array.prototype, 'slice')
    try {
      const next = applyPatch(prev, patch) as { id: number }[]
      expect(slice).toHaveBeenCalledTimes(1)
      expect(next.map((r) => r.id)).toStrictEqual(prev.map((r) => r.id).reverse())
      expect(prev[0]).toStrictEqual({ id: 0 })
    } finally {
      slice.mockRestore()
    }
  })

  it('a rejected patch leaves the input untouched', () => {
    const prev = deepFreeze({ a: [1, 2], b: 1 }) as Json
    expect(() => applyPatch(prev, [['set', '/b', 2], ['del', '/a/7']])).toThrow()
    expect(prev).toStrictEqual({ a: [1, 2], b: 1 })
  })
})

// ---------- structurally shared edits ----------

// Edits in the style the docs prescribe: copy the spine, share every sibling.
// `steps` picks a random descent; `kind` picks what happens where it stops.
type Edit = { steps: number[]; kind: number; key: string; value: Json }

const isRec = (v: Json): v is { [key: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v)

function applyEdit(doc: Json, e: Edit, shapes: boolean, depth = 0): Json {
  const s = e.steps[depth]
  if (s !== undefined && s % 3 !== 0) {
    if (Array.isArray(doc) && doc.length > 0) {
      const i = s % doc.length
      const copy = doc.slice()
      copy[i] = applyEdit(doc[i] as Json, e, shapes, depth + 1)
      return copy
    }
    if (isRec(doc) && Object.keys(doc).length > 0) {
      const keys = Object.keys(doc)
      const k = keys[s % keys.length] as string
      return { ...doc, [k]: applyEdit(doc[k] as Json, e, shapes, depth + 1) }
    }
  }
  if (Array.isArray(doc) && shapes) {
    const at = e.kind % (doc.length + 1)
    if (e.kind % 2 === 0 || doc.length === 0) return [...doc.slice(0, at), e.value, ...doc.slice(at)]
    return [...doc.slice(0, at), ...doc.slice(at + 1)]
  }
  if (isRec(doc)) {
    const keys = Object.keys(doc)
    if (e.kind % 2 === 1 && keys.length > 0) {
      const gone = keys[e.kind % keys.length] as string
      return Object.fromEntries(keys.filter((k) => k !== gone).map((k) => [k, doc[k] as Json]))
    }
    return { ...doc, [e.key]: e.value }
  }
  return e.value
}

const primitive: fc.Arbitrary<Json> = fc.oneof(fc.constant(null), fc.boolean(), fc.integer(), fc.string({ maxLength: 4 }))
const edits = (value: fc.Arbitrary<Json>): fc.Arbitrary<Edit[]> =>
  fc.array(
    fc.record({ steps: fc.array(fc.nat(30), { maxLength: 5 }), kind: fc.nat(30), key, value }),
    { minLength: 1, maxLength: 6 },
  )

describe('reconcile over structurally shared edits', () => {
  it('round-trips any sequence of spine-copying edits, shape changes included', () => {
    fc.assert(
      fc.property(json, edits(json), (prev, es) => {
        const next = es.reduce((d, e) => applyEdit(d, e, true), prev)
        expect(applyPatch(prev, reconcile(prev, next))).toStrictEqual(next)
      }),
      { numRuns: 500 },
    )
  })

  it('emits at most one op per edit when the edits keep array shapes', () => {
    fc.assert(
      fc.property(json, edits(primitive), (prev, es) => {
        const next = es.reduce((d, e) => applyEdit(d, e, false), prev)
        const patch = reconcile(prev, next)
        expect(applyPatch(prev, patch)).toStrictEqual(next)
        expect(patch.length).toBeLessThanOrEqual(es.length)
      }),
      { numRuns: 500 },
    )
  })

  it('a single edit anywhere, array inserts and removals included, is at most one op', () => {
    fc.assert(
      fc.property(json, edits(primitive).map((es) => es.slice(0, 1)), (prev, [e]) => {
        const next = applyEdit(prev, e!, true)
        const patch = reconcile(prev, next)
        expect(applyPatch(prev, patch)).toStrictEqual(next)
        expect(patch.length).toBeLessThanOrEqual(1)
      }),
      { numRuns: 500 },
    )
  })
})

describe('isRecord', () => {
  it.each([
    [{}, true],
    [Object.create(null), true],
    [[], false],
    [null, false],
    ['s', false],
    [new Date(0), false],
    [new Map(), false],
    [Object.create({}), false],
  ])('%o is a record: %s', (v, expected) => {
    expect(isRecord(v)).toBe(expected)
  })
})
