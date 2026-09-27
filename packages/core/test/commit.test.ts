// The publication boundary: `commit(base, next, patch)` installs a snapshot
// and invalidates readers from changes a producer already knows, with no
// reconcile. The producer here is private to the test: it edits a state op by
// op (set / del / splice, the vocabulary applyPatch accepts, including the
// array `del` the diff never emits) and hands over next plus the ops. Readers
// are then held to one rule: after a flush, each shows what it would compute
// from the new snapshot read raw.

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { effect, flush, source, type Source } from '../src/graph.ts'
import { applyPatch, reconcile, type Json, type Op, type Patch } from '../src/reconcile.ts'
import { escapeSegment } from '../src/pointer.ts'
import { spawn, instrument, type ProcessEvent } from '../src/index.ts'

// ---------- a private change producer ----------

type Rand = () => number

const mulberry = (seed: number): Rand => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T

const leafValue = (r: Rand): Json => pick<Json>(r, [0, 1, 2, 'a', 'b', true, null, [], {}, [1, 2], { x: 1 }])

const freshValue = (r: Rand, depth = 0): Json => {
  const k = r()
  if (depth > 2 || k < 0.5) return leafValue(r)
  if (k < 0.75) return Array.from({ length: Math.floor(r() * 4) }, () => freshValue(r, depth + 1))
  const o: { [key: string]: Json } = {}
  for (let i = Math.floor(r() * 4); i > 0; i--) o[pick(r, ['a', 'b', 'c', 'd'])] = freshValue(r, depth + 1)
  return o
}

/** Every container in `doc`, with its pointer. */
function containers(doc: Json, path = '', out: [string, Json[] | { [key: string]: Json }][] = []) {
  if (typeof doc !== 'object' || doc === null) return out
  out.push([path, doc])
  if (Array.isArray(doc)) doc.forEach((v, i) => containers(v, `${path}/${i}`, out))
  else for (const k of Object.keys(doc)) containers(doc[k] as Json, `${path}/${escapeSegment(k)}`, out)
  return out
}

/** One op valid against `doc`: set, del, or splice, on a random container (the root included). */
function randomOp(r: Rand, doc: Json): Op {
  const cs = containers(doc)
  if (cs.length === 0 || r() < 0.05) return ['set', '', freshValue(r)]
  const [path, c] = pick(r, cs)
  if (Array.isArray(c)) {
    const n = c.length
    const roll = r()
    if (n > 0 && roll < 0.3) return ['set', `${path}/${Math.floor(r() * n)}`, freshValue(r)]
    if (n > 0 && roll < 0.5) return ['del', `${path}/${Math.floor(r() * n)}`]
    const start = Math.floor(r() * (n + 1))
    const remove = Math.floor(r() * (n - start + 1))
    return ['splice', path, start, remove, Array.from({ length: Math.floor(r() * 3) }, () => freshValue(r))]
  }
  const keys = Object.keys(c)
  if (keys.length > 0 && r() < 0.35) return ['del', `${path}/${escapeSegment(pick(r, keys))}`]
  return ['set', `${path}/${pick(r, ['a', 'b', 'c', 'd', 'e'])}`, freshValue(r)]
}

/** A transition as a producer that knows its own changes would report it: ops in application order, each against the state before it. */
function edit(r: Rand, base: Json, count: number): { next: Json; patch: Patch } {
  const patch: Patch = []
  let next = base
  for (let i = 0; i < count; i++) {
    const op = randomOp(r, next)
    next = applyPatch(next, [op])
    patch.push(op)
  }
  return { next, patch }
}

// ---------- readers ----------

type View = { [key: string]: unknown } & unknown[]

/** What a reader computes, run against a (possibly tracked) snapshot. Each kind exercises one read shape. */
type Reader = (doc: Json) => string

const walk = (doc: Json, segs: string[]): Json | undefined => {
  let cur: Json | undefined = doc
  for (const s of segs) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as View)[s as never] as Json | undefined
  }
  return cur
}

function randomReader(r: Rand, doc: Json): Reader {
  // paths that exist, plus a missing key or an index past the end under one
  const cs = containers(doc)
  const [path, c] = cs.length > 0 ? pick(r, cs) : ['', null]
  const segs = path === '' ? [] : path.slice(1).split('/').map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'))
  const child = Array.isArray(c) ? String(Math.floor(r() * (c.length + 2))) : pick(r, ['a', 'b', 'c', 'd', 'e'])
  switch (Math.floor(r() * 6)) {
    case 0: // a leaf, or a missing entry, under the container
      return (d) => {
        const v = walk(d, [...segs, child])
        return typeof v === 'object' && v !== null ? 'container' : JSON.stringify(v ?? 'missing')
      }
    case 1: // presence only
      return (d) => {
        const v = walk(d, segs)
        return typeof v === 'object' && v !== null ? String(child in v) : 'none'
      }
    case 2: // keys / length
      return (d) => {
        const v = walk(d, segs)
        return typeof v === 'object' && v !== null ? (Array.isArray(v) ? `len ${v.length}` : Object.keys(v).join(',')) : 'none'
      }
    case 3: // iteration over an array
      return (d) => {
        const v = walk(d, segs)
        return Array.isArray(v) ? v.map((x) => typeof x).join(',') : 'none'
      }
    case 4: // the whole subtree
      return (d) => JSON.stringify(walk(d, segs) ?? 'missing')
    default: // a primitive at an exact position, if there is one
      return (d) => {
        const v = walk(d, segs)
        return typeof v === 'object' && v !== null ? 'container' : JSON.stringify(v ?? 'missing')
      }
  }
}

/** Mount readers over `src`; each records every value it computes. */
function watch(src: Source<Json>, readers: Reader[]) {
  const seen: string[][] = readers.map(() => [])
  const stops = readers.map((read, i) => effect(() => void seen[i]!.push(read(src()))))
  return {
    seen,
    last: () => seen.map((s) => s[s.length - 1]),
    runs: () => seen.map((s) => s.length),
    stop: () => stops.forEach((s) => s()),
  }
}

// ---------- the boundary ----------

describe('commit: publishing supplied changes', () => {
  it('a supplied patch reconstructs next, and every reader then matches next read raw', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const r = mulberry(seed)
        const base = freshValue(r)
        const readers = Array.from({ length: 8 }, () => randomReader(r, base))
        const { next, patch } = edit(r, base, 1 + Math.floor(r() * 4))
        expect(applyPatch(base, patch)).toEqual(next)

        const src = source<Json>(base)
        const w = watch(src, readers)
        src.commit(base, next, patch)
        flush()
        expect(src()).toBe(next)
        expect(w.last()).toEqual(readers.map((read) => read(next)))
        w.stop()
      }),
      { numRuns: 400 },
    )
  })

  it('wakes exactly the readers publish would when the supplied patch is the diff', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const r = mulberry(seed)
        const base = freshValue(r)
        const readers = Array.from({ length: 8 }, () => randomReader(r, base))
        const { next } = edit(r, base, 1 + Math.floor(r() * 4))

        const viaDiff = source<Json>(base)
        const viaCommit = source<Json>(base)
        const a = watch(viaDiff, readers)
        const b = watch(viaCommit, readers)
        viaDiff.publish(next)
        viaCommit.commit(base, next, reconcile(base, next))
        flush()
        expect(b.runs()).toEqual(a.runs())
        expect(b.last()).toEqual(a.last())
        a.stop()
        b.stop()
      }),
      { numRuns: 300 },
    )
  })

  it('successive commits before one flush lose nothing, however the edits overlap', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const r = mulberry(seed)
        let state = freshValue(r)
        const readers = Array.from({ length: 8 }, () => randomReader(r, state))
        const src = source<Json>(state)
        const w = watch(src, readers)
        for (let i = 0, n = 2 + Math.floor(r() * 3); i < n; i++) {
          const { next, patch } = edit(r, state, 1 + Math.floor(r() * 2))
          src.commit(state, next, patch)
          state = next
        }
        flush()
        expect(w.last()).toEqual(readers.map((read) => read(state)))
        w.stop()
      }),
      { numRuns: 300 },
    )
  })

  it('refuses a patch whose base is not the current snapshot, installing nothing and waking no one', () => {
    const base = { a: 1 }
    const src = source<Json>(base)
    const w = watch(src, [(d) => JSON.stringify(d)])
    src.publish({ a: 2 })
    const installed = src()
    expect(() => src.commit(base, { a: 3 }, [['set', '/a', 3]])).toThrow(/base/)
    flush()
    expect(src()).toBe(installed)
    expect(w.seen[0]).toEqual(['{"a":1}', '{"a":2}'])
    w.stop()
  })

  it('an equal primitive is the same base: a patch is a function of the value it applies to', () => {
    const src = source<Json>(1)
    const w = watch(src, [(d) => String(d)])
    src.commit(1, 2, [['set', '', 2]])
    flush()
    expect(w.seen[0]).toEqual(['1', '2'])
    w.stop()
  })

  it('a no-op transition installs the new snapshot and wakes no one', () => {
    const base = { rows: [{ id: 1 }] }
    const same = { rows: base.rows }
    const src = source<Json>(base)
    const w = watch(src, [(d) => JSON.stringify(d)])
    src.commit(base, same, [])
    flush()
    expect(src()).toBe(same)
    expect(w.runs()).toEqual([1])
    w.stop()
  })
})

describe('commit: dependency semantics of supplied ops', () => {
  const rows = (): Json => ({ items: ['a', 'b', 'c', 'd', 'e'], meta: { n: 5 } })

  /** Wake counts (after the first run) per reader for one supplied op. */
  const wakes = (op: Op, readers: Reader[]): number[] => {
    const base = rows()
    const src = source<Json>(base)
    const w = watch(src, readers)
    src.commit(base, applyPatch(base, [op]), [op])
    flush()
    const runs = w.runs().map((n) => n - 1)
    w.stop()
    return runs
  }

  const at = (i: number): Reader => (d) => String((d as { items: string[] }).items[i])
  const len: Reader = (d) => String((d as { items: string[] }).items.length)
  const n: Reader = (d) => String((d as { meta?: { n: number } }).meta?.n)
  const hasMeta: Reader = (d) => String('meta' in (d as object))

  it('an array del shifts every later index: readers from that index on wake, earlier ones sleep', () => {
    expect(wakes(['del', '/items/2'], [at(0), at(1), at(2), at(3), at(4), len, n])).toEqual([0, 0, 1, 1, 1, 1, 0])
  })

  it('a splice wakes positional reads at or after its start, however far past the edit', () => {
    expect(wakes(['splice', '/items', 1, 1, ['x']], [at(0), at(1), at(4), len, n])).toEqual([0, 1, 1, 1, 0])
    expect(wakes(['splice', '/items', 5, 0, ['f']], [at(0), at(4), at(5), len])).toEqual([0, 0, 1, 1])
  })

  it('an element set wakes that index alone, not length or its neighbours', () => {
    expect(wakes(['set', '/items/2', 'z'], [at(1), at(2), at(3), len])).toEqual([0, 1, 0, 0])
  })

  it('replacing an ancestor wakes every reader beneath it; deleting a key wakes its readers and presence checks', () => {
    expect(wakes(['set', '/items', []], [at(0), len, n])).toEqual([1, 1, 0])
    expect(wakes(['del', '/meta'], [n, hasMeta, at(0)])).toEqual([1, 1, 0])
  })

  it('a change beneath a key leaves its presence check asleep', () => {
    expect(wakes(['set', '/meta/n', 6], [n, hasMeta])).toEqual([1, 0])
  })

  it('a commit landing mid-run is judged against what the run goes on to read', () => {
    const base = rows()
    const src = source<Json>(base)
    let runs = 0
    let seen = ''
    const stop = effect(() => {
      runs++
      const d = src() as { items: string[] }
      if (runs === 1) {
        const next = applyPatch(base, [['del', '/items/0']])
        src.commit(base, next, [['del', '/items/0']])
      }
      seen = d.items[3] as string // read after the commit, from the snapshot the run opened
    })
    flush()
    expect(runs).toBe(2)
    expect(seen).toBe('e')
    stop()
  })
})

describe('publication: sources and processes', () => {
  it('a publish with no reader installs the snapshot, and a reader that arrives later diffs from it', () => {
    const src = source<Json>({ a: 1, b: 1 })
    src.publish({ a: 2, b: 1 })
    const w = watch(src, [(d) => String((d as { a: number }).a), (d) => String((d as { b: number }).b)])
    src.publish({ a: 2, b: 2 })
    flush()
    expect(w.seen).toEqual([['2'], ['1', '2']])
    w.stop()
  })

  it('under an instrument sink, a yield reports the ops readers are invalidated with', async () => {
    const events: ProcessEvent[] = []
    const remove = instrument((e) => void events.push(e))
    const p = spawn(
      async function* (self: AsyncIterable<{ i: number }>) {
        let s = { rows: [{ v: 0 }, { v: 0 }], total: 0 }
        for await (const { i } of self) {
          s = { ...s, rows: s.rows.with(i, { v: 1 }), total: s.total + 1 }
          yield s
        }
      },
      undefined,
      { initial: { rows: [{ v: 0 }, { v: 0 }], total: 0 } },
    )
    const runs = [0, 0]
    const stops = [0, 1].map((i) => effect(() => {
      void p().rows[i]!.v
      runs[i]!++
    }))
    p.cast({ i: 1 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    flush()
    const ops = events.flatMap((e) => (e.type === 'yield' ? [e.ops] : []))
    expect(ops).toEqual([[['set', '/rows/1/v', 1], ['set', '/total', 1]]])
    expect(runs).toEqual([1, 2])
    stops.forEach((s) => s())
    p[Symbol.dispose]()
    remove()
  })
})
