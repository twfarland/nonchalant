import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { source, effect, flush, untracked } from '../src/graph.ts'
import { derive } from '../src/index.ts'
import { affects, createRecorder, type PathTree } from '../src/track.ts'
import type { Json, Patch } from '../src/reconcile.ts'

type Item = { done: boolean; n: number }
type State = { items: Item[]; total: number; meta: { tag: string } }

const mkState = (): State => ({
  items: [
    { done: false, n: 0 },
    { done: false, n: 1 },
    { done: false, n: 2 },
    { done: false, n: 3 },
  ],
  total: 0,
  meta: { tag: 'x' },
})

describe('source reads', () => {
  it('untracked reads return the raw snapshot, identity intact', () => {
    const snap = mkState()
    const src = source<State>(snap)
    expect(src()).toBe(snap)
  })

  it('tracked snapshots are proxied and read-only', () => {
    const src = source<State>(mkState())
    let inside: State | undefined
    let threw: unknown
    const stop = effect(() => {
      inside = src()
      try {
        ;(inside as { total: number }).total = 99
      } catch (e) {
        threw = e
      }
    })
    expect(inside).not.toBe(src())
    expect(inside!.total).toBe(0)
    expect(String(threw)).toMatch(/read-only/)
    expect(src().total).toBe(0)
    stop()
  })

  it('deeply frozen snapshots remain trackable', () => {
    const initial: Readonly<{ nested: Readonly<{ n: number }>; other: number }> =
      Object.freeze({ nested: Object.freeze({ n: 1 }), other: 0 })
    const src = source(initial)
    let seen = 0
    let runs = 0
    const stop = effect(() => {
      runs++
      seen = src().nested.n
    })
    expect(seen).toBe(1)

    src.publish(Object.freeze({ nested: Object.freeze({ n: 2 }), other: 0 }))
    flush()
    expect(seen).toBe(2)
    expect(runs).toBe(2)
    stop()
  })

  it('untracked() suspends subscription inside a tracked body', () => {
    const src = source<{ n: number }>({ n: 1 })
    let runs = 0
    const stop = effect(() => {
      runs++
      untracked(() => src().n)
    })
    src.publish({ n: 2 })
    flush()
    expect(runs).toBe(1)
    stop()
  })
})

describe('notification precision (exact wake counts per patch)', () => {
  it('wakes exactly the readers whose recorded paths the patch touches', () => {
    const src = source<State>(mkState())
    let totalRuns = 0
    let itemRuns = 0
    let lenRuns = 0
    let escRuns = 0
    const stops = [
      effect(() => { totalRuns++; void src().total }),
      effect(() => { itemRuns++; void src().items[2]!.done }),
      effect(() => { lenRuns++; void src().items.length }),
      effect(() => { escRuns++; void src().meta }), // container escapes → subtree dependency
    ]
    const counts = (): number[] => [totalRuns, itemRuns, lenRuns, escRuns]
    expect(counts()).toEqual([1, 1, 1, 1])

    // scalar sibling: only the total reader
    src.publish({ ...src(), total: 5 })
    flush()
    expect(counts()).toEqual([2, 1, 1, 1])

    // deep change at an index nobody reads: zero wakes
    let cur = src()
    src.publish({ ...cur, items: cur.items.map((it, i) => (i === 0 ? { ...it, done: true } : it)) })
    flush()
    expect(counts()).toEqual([2, 1, 1, 1])

    // deep change at the read index: only the item reader
    cur = src()
    src.publish({ ...cur, items: cur.items.map((it, i) => (i === 2 ? { ...it, done: true } : it)) })
    flush()
    expect(counts()).toEqual([2, 2, 1, 1])

    // append (splice at 4): length reader only — index 2 sits before the splice
    cur = src()
    src.publish({ ...cur, items: [...cur.items, { done: false, n: 9 }] })
    flush()
    expect(counts()).toEqual([2, 2, 2, 1])

    // remove at 0: indices shift — item reader and length reader
    cur = src()
    src.publish({ ...cur, items: cur.items.slice(1) })
    flush()
    expect(counts()).toEqual([2, 3, 3, 1])

    // escaped container: any op under /meta wakes its holder
    cur = src()
    src.publish({ ...cur, meta: { tag: 'y' } })
    flush()
    expect(counts()).toEqual([2, 3, 3, 2])

    for (const stop of stops) stop()
  })

  it('composes with derives: path cut at the gate, value cut at the derive', () => {
    const src = source<State>(mkState())
    const nonEmpty = derive(() => src().items.length > 0)
    let runs = 0
    const stop = effect(() => {
      runs++
      void nonEmpty()
      void src().total
    })
    expect(runs).toBe(1)

    // deep item change: derive's paths (length) untouched → nothing recomputes
    let cur = src()
    src.publish({ ...cur, items: cur.items.map((it, i) => (i === 1 ? { ...it, done: true } : it)) })
    flush()
    expect(runs).toBe(1)

    // append: derive recomputes, value unchanged → equality cut, effect stays asleep
    cur = src()
    src.publish({ ...cur, items: [...cur.items, { done: false, n: 9 }] })
    flush()
    expect(runs).toBe(1)

    // the effect's own path: wakes
    cur = src()
    src.publish({ ...cur, total: 9 })
    flush()
    expect(runs).toBe(2)
    stop()
  })
})

describe('diamond / glitch freedom', () => {
  it('joins see one consistent recompute per publish, never a torn value', () => {
    const src = source<{ a: number }>({ a: 1 })
    const d1 = derive(() => src().a * 2)
    const d2 = derive(() => src().a + 1)
    const seen: number[] = []
    const stop = effect(() => {
      seen.push(d1() + d2())
    })
    expect(seen).toEqual([4])
    src.publish({ a: 2 })
    flush()
    // the glitched mix (new d1 + old d2 = 6) must never be observed
    expect(seen).toEqual([4, 7])
    stop()
  })

  it('pull reads are consistent even before any flush', () => {
    const src = source<{ a: number }>({ a: 1 })
    const d1 = derive(() => src().a * 2)
    const sum = derive(() => d1() + src().a)
    expect(sum()).toBe(3)
    src.publish({ a: 10 })
    expect(sum()).toBe(30) // no flush needed — derives are pull-based
  })
})

describe('batching', () => {
  it('publishes in one tick batch to a single microtask flush', async () => {
    const src = source<{ n: number }>({ n: 0 })
    let runs = 0
    const stop = effect(() => {
      runs++
      void src().n
    })
    src.publish({ n: 1 })
    src.publish({ n: 2 })
    expect(runs).toBe(1) // nothing ran synchronously
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runs).toBe(2) // both publishes, one wake
    expect(src().n).toBe(2)
    stop()
  })

  it('flush() drains synchronously', () => {
    const src = source<{ n: number }>({ n: 0 })
    let runs = 0
    const stop = effect(() => {
      runs++
      void src().n
    })
    src.publish({ n: 1 })
    expect(runs).toBe(1)
    flush()
    expect(runs).toBe(2)
    stop()
  })
})

describe('publishes during a reader run (deferred wake decision)', () => {
  it('wakes the reader when the in-flight run read a path the publish changed', () => {
    // the read-set grows to /b in run 2; a mid-run publish to /b must not be
    // judged against run 1's paths and lost
    const src = source<{ mode: string; a: number; b: number }>({ mode: 'a', a: 0, b: 0 })
    let runs = 0
    let seen = -1
    const stop = effect(() => {
      runs++
      const v = src()
      if (v.mode === 'a') {
        seen = v.a
      } else {
        seen = v.b
        if (v.b === 0) src.publish({ mode: 'b', a: 0, b: 1 })
      }
    })
    expect(runs).toBe(1)
    src.publish({ mode: 'b', a: 0, b: 0 })
    flush()
    expect(runs).toBe(3) // mode switch, then the deferred /b wake
    expect(seen).toBe(1)
    stop()
  })

  it('skips the reader when the in-flight run never read the changed path', () => {
    // a mid-run publish to an untouched sibling wakes other readers, not the writer
    const src = source<{ a: number; z: number }>({ a: 0, z: 0 })
    let aRuns = 0
    let zRuns = 0
    let zSeen = 0
    const stopA = effect(() => {
      aRuns++
      if (src().a === 1) src.publish({ a: 1, z: 99 })
    })
    const stopZ = effect(() => {
      zRuns++
      zSeen = src().z
    })
    src.publish({ a: 1, z: 0 })
    flush()
    expect(aRuns).toBe(2) // initial + the /a wake — its own /z publish must not re-run it
    expect(zRuns).toBe(2) // initial + the /z publish from inside A's run
    expect(zSeen).toBe(99)
    stopA()
    stopZ()
  })

  it('a path read only after the mid-run publish still wakes the reader', () => {
    // the read comes after the publish but sees the pre-publish snapshot (the
    // recorder wraps the snapshot captured at first read) — must not stay stale
    const src = source<{ go: boolean; n: number }>({ go: false, n: 0 })
    let runs = 0
    let last = -2
    let published = false
    const stop = effect(() => {
      runs++
      const v = src()
      if (v.go && !published) {
        published = true
        src.publish({ go: true, n: 1 })
      }
      last = v.go ? v.n : -1
    })
    src.publish({ go: true, n: 0 })
    flush()
    expect(runs).toBe(3)
    expect(last).toBe(1)
    stop()
  })

  it('a publish during the first run is judged against the finalized paths', () => {
    // related path → exactly one re-run
    const src = source<{ n: number; other: number }>({ n: 0, other: 0 })
    let runs = 0
    let seen = -1
    const stop = effect(() => {
      runs++
      seen = src().n
      if (runs === 1) src.publish({ n: 5, other: 0 })
    })
    expect(runs).toBe(1)
    flush()
    expect(runs).toBe(2)
    expect(seen).toBe(5)
    stop()

    // unrelated path → no re-run
    const src2 = source<{ n: number; other: number }>({ n: 0, other: 0 })
    let runs2 = 0
    const stop2 = effect(() => {
      runs2++
      void src2().n
      if (runs2 === 1) src2.publish({ n: 0, other: 1 })
    })
    flush()
    expect(runs2).toBe(1)
    stop2()
  })

  it('a mid-run publish reaching the reader only through a derive still wakes it', () => {
    // the wake propagates while the reader is mid-run (PENDING is set without a
    // queue entry) — the reader must be re-queued when its run ends
    const src = source<{ n: number; written: boolean }>({ n: 0, written: false })
    const doubled = derive(() => src().n * 2)
    let runs = 0
    let seen = -1
    const stop = effect(() => {
      runs++
      seen = doubled()
      if (!untracked(() => src().written)) src.publish({ n: 1, written: true })
    })
    flush()
    expect(runs).toBe(2)
    expect(seen).toBe(2)
    stop()
  })
})

describe('flush error handling', () => {
  it('an effect that throws does not strand later queued effects', () => {
    const src = source<{ n: number }>({ n: 0 })
    let seen = -1
    const stopBoom = effect(() => {
      if (src().n === 1) throw new Error('boom')
    })
    const stopTail = effect(() => {
      seen = src().n
    })
    src.publish({ n: 1 })
    expect(() => flush()).toThrow('boom')
    expect(seen).toBe(1) // the effect queued behind the thrower still ran
    src.publish({ n: 2 })
    flush() // the queue is clean afterwards
    expect(seen).toBe(2)
    stopBoom()
    stopTail()
  })

  it('only the first error propagates; every queued effect still runs', () => {
    const src = source<{ n: number }>({ n: 0 })
    let tailRuns = 0
    const stops = [
      effect(() => {
        if (src().n === 1) throw new Error('first')
      }),
      effect(() => {
        if (src().n === 1) throw new Error('second')
      }),
      effect(() => {
        tailRuns += src().n
      }),
    ]
    src.publish({ n: 1 })
    expect(() => flush()).toThrow('first')
    expect(tailRuns).toBe(1)
    for (const stop of stops) stop()
  })
})

describe('effect lifecycle', () => {
  it('an effect that throws on its first run releases every dependency', () => {
    let watchers = 0
    const src = source(
      { n: 0 },
      { onWatchers: (count) => (watchers = count) },
    )

    expect(() =>
      effect(() => {
        void src().n
        throw new Error('initial failure')
      }),
    ).toThrow('initial failure')
    expect(watchers).toBe(0)
  })

  it('only function returns are treated as cleanups', () => {
    // TypeScript callers get the narrow return type, but the runtime boundary
    // must remain safe for JavaScript and dynamically composed effects.
    const stop = effect((() => 1) as () => void)
    expect(() => stop()).not.toThrow()
  })

  it('a returned cleanup runs before each re-run and on dispose', () => {
    const src = source<{ n: number }>({ n: 0 })
    const log: string[] = []
    const stop = effect(() => {
      const n = src().n
      log.push(`run ${n}`)
      return () => log.push(`clean ${n}`)
    })
    src.publish({ n: 1 })
    flush()
    stop()
    expect(log).toEqual(['run 0', 'clean 0', 'run 1', 'clean 1'])
  })

  it('effects spawned inside an effect die with their parent', () => {
    const src = source<{ n: number }>({ n: 0 })
    let childRuns = 0
    const stop = effect(() => {
      void src().n
      effect(() => {
        childRuns++
        void src().n
      })
    })
    expect(childRuns).toBe(1)
    stop()
    src.publish({ n: 1 })
    flush()
    expect(childRuns).toBe(1) // child was disposed with the parent, not leaked
  })
})

describe('derive as Process', () => {
  it('is callable and exposes pending/stale/error', () => {
    const src = source<{ n: number }>({ n: 2 })
    const d = derive(() => src().n * 10)
    expect(d()).toBe(20)
    expect(d.pending).toBe(false)
    expect(d.stale).toBe(false)
    expect(d.error).toBeUndefined()
  })

  it('surfaces getter failures as error and recovers on the next good value', () => {
    const src = source<{ n: number }>({ n: 1 })
    const d = derive(() => {
      const n = src().n
      if (n < 0) throw new Error('negative')
      return n
    })
    expect(d()).toBe(1)
    src.publish({ n: -1 })
    expect(() => d()).toThrow('negative')
    expect(d.error).toBeInstanceOf(Error)
    src.publish({ n: 3 })
    expect(d()).toBe(3)
    expect(d.error).toBeUndefined()
  })

  it('error-only readers wake on failure and recovery', () => {
    const src = source<{ n: number }>({ n: 1 })
    const d = derive(() => {
      const n = src().n
      if (n < 0) throw new Error('negative')
      return n
    })
    expect(d()).toBe(1)
    let seen: unknown
    let runs = 0
    const stop = effect(() => {
      runs++
      seen = d.error
    })

    src.publish({ n: -1 })
    expect(() => d()).toThrow('negative')
    flush()
    expect(seen).toBeInstanceOf(Error)

    src.publish({ n: 2 })
    expect(d()).toBe(2)
    flush()
    expect(seen).toBeUndefined()
    expect(runs).toBe(3)
    stop()
  })

  it('Object.is equality keeps stable NaN results quiet', () => {
    const src = source<{ n: number }>({ n: 0 })
    const d = derive(() => {
      void src().n
      return Number.NaN
    })
    let runs = 0
    const stop = effect(() => {
      runs++
      void d()
    })
    src.publish({ n: 1 })
    flush()
    expect(runs).toBe(1)
    stop()
  })

  it('async iteration is a lossy latest-value stream', async () => {
    const src = source<{ n: number }>({ n: 1 })
    const d = derive(() => src().n)
    const it = d[Symbol.asyncIterator]()
    expect(await it.next()).toEqual({ value: 1, done: false })
    src.publish({ n: 2 })
    flush()
    expect((await it.next()).value).toBe(2)
    src.publish({ n: 3 })
    src.publish({ n: 4 })
    flush()
    expect((await it.next()).value).toBe(4) // 3 was dropped: lossy by design
    await it.return!()
    expect((await it.next()).done).toBe(true)
  })

  it('dispose ends iteration, freezes the value, marks it stale', async () => {
    const src = source<{ n: number }>({ n: 1 })
    const d = derive(() => src().n)
    expect(d()).toBe(1)
    const it = d[Symbol.asyncIterator]()
    await it.next()
    d[Symbol.dispose]()
    expect(d.stale).toBe(true)
    src.publish({ n: 5 })
    flush()
    expect(d()).toBe(1)
    expect((await it.next()).done).toBe(true)
  })

  it('an unread derive throws after disposal instead of violating its value type', () => {
    const d = derive(() => 123)
    d[Symbol.dispose]()
    expect(() => d()).toThrow(/disposed before its first value/)
  })
})

describe('path intersection boundaries (affects)', () => {
  const record = (reader: (s: State) => void): PathTree => {
    const r = createRecorder()
    reader(r.wrap(mkState() as unknown as Json) as unknown as State)
    return r.finalize()
  }

  it('splice wakes reads at or after its start index, not before', () => {
    const tree = record((s) => void s.items[2]!.done)
    expect(affects(tree, [['splice', '/items', 3, 0, [{ done: false, n: 9 }]]] as Patch)).toBe(false)
    expect(affects(tree, [['splice', '/items', 2, 1, []]] as Patch)).toBe(true)
    expect(affects(tree, [['splice', '/items', 0, 0, [{ done: false, n: 9 }]]] as Patch)).toBe(true)
  })

  it('key observation is structural: shape ops wake, sibling scalars do not', () => {
    const tree = record((s) => void Object.keys(s.meta))
    expect(affects(tree, [['del', '/meta/tag']] as Patch)).toBe(true)
    expect(affects(tree, [['set', '/meta/added', 1]] as Patch)).toBe(true)
    expect(affects(tree, [['set', '/total', 1]] as Patch)).toBe(false)
  })

  it('reads of an absent key wake when the key appears', () => {
    const tree = record((s) => void (s as { maybe?: number }).maybe)
    expect(affects(tree, [['set', '/maybe', 1]] as Patch)).toBe(true)
    expect(affects(tree, [['set', '/total', 1]] as Patch)).toBe(false)
  })

  it('Object.hasOwn observations track the inspected key', () => {
    const tree = record((s) => void Object.hasOwn(s.meta, 'missing'))
    expect(affects(tree, [['set', '/meta/missing', 1]] as Patch)).toBe(true)
    expect(affects(tree, [['set', '/meta/tag', 'changed']] as Patch)).toBe(false)
    expect(affects(tree, [['set', '/total', 1]] as Patch)).toBe(false)
  })

  it('a replaced ancestor wakes every read beneath it', () => {
    const tree = record((s) => void s.items[0]!.n)
    expect(affects(tree, [['set', '/items', []]] as Patch)).toBe(true)
    expect(affects(tree, [['set', '', null]] as Patch)).toBe(true)
  })
})

// ---------- properties ----------
//
// The example tests above pin the cases we reasoned about. These two pin the
// contract itself over states and patches nobody chose: a reader must wake
// whenever what it read changed (a missed wake is a silently wrong UI), and
// must not wake for a write that lands nowhere it looked (a spurious wake is
// the re-render tax this library exists to avoid).

const jsonKey = fc.oneof(fc.constantFrom('a', 'b', 'c', 'items', 'meta', 'n'), fc.string({ maxLength: 3 }))

const { jsonValue } = fc.letrec<{ jsonValue: Json }>((tie) => ({
  jsonValue: fc.oneof(
    { maxDepth: 3, withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -4, max: 4 }),
    fc.string({ maxLength: 3 }),
    fc.array(tie('jsonValue'), { maxLength: 4 }),
    fc.dictionary(jsonKey, tie('jsonValue'), { maxKeys: 4 }).map((d) => ({ ...d })),
  ),
}))

// An object at the root with a keyed list in it — the shape this library is
// about, and the only way to reach the splice paths in `affects`.
const row = fc.record({ done: fc.boolean(), n: fc.integer({ min: -4, max: 4 }) })

const jsonState: fc.Arbitrary<Json> = fc
  .tuple(fc.dictionary(jsonKey, jsonValue, { maxKeys: 3 }), fc.array(row, { maxLength: 4 }))
  .map(([rest, items]) => ({ ...rest, items }) as Json)

const readPath = fc.oneof(
  fc.array(fc.oneof(jsonKey, fc.constantFrom('0', '1', '2')), { maxLength: 3 }),
  fc.tuple(fc.constant('items'), fc.constantFrom('0', '1', '2', '3'), fc.constantFrom('done', 'n'))
    .map((segs) => [...segs]),
  fc.constant(['items']),
)

const at = (v: unknown, segs: readonly string[]): unknown => {
  let cur = v
  for (const seg of segs) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** What a reader reads, and the value it would show. Stringify so containers are read through. */
const project = (v: unknown, paths: readonly (readonly string[])[]): string =>
  paths.map((p) => JSON.stringify(at(v, p)) ?? 'undefined').join('|')

/** Every path to a scalar leaf in a value. */
const leafPaths = (v: unknown, prefix: string[] = []): string[][] => {
  if (v === null || typeof v !== 'object') return prefix.length === 0 ? [] : [prefix]
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v)
  return entries.flatMap(([k, child]) => leafPaths(child, [...prefix, k]))
}

const updateAt = (v: Json, segs: readonly string[], fn: (leaf: Json) => Json): Json => {
  if (segs.length === 0) return fn(v)
  const [head, ...rest] = segs as [string, ...string[]]
  if (Array.isArray(v)) {
    const i = Number(head)
    return v.map((x, j) => (j === i ? updateAt(x, rest, fn) : x)) // untouched elements keep identity
  }
  const obj = v as { [k: string]: Json }
  return { ...obj, [head]: updateAt(obj[head] as Json, rest, fn) }
}

/** Paths to every array in a value, so edits can splice where splices are possible. */
const arrayPaths = (v: unknown, prefix: string[] = []): string[][] => {
  if (v === null || typeof v !== 'object') return []
  const here = Array.isArray(v) ? [prefix] : []
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v)
  return [...here, ...entries.flatMap(([k, child]) => arrayPaths(child, [...prefix, k]))]
}

type Edit = { kind: 'set' | 'insert' | 'remove'; where: number; value: Json }

/** One edit, written the way application code writes them: spread and share. */
const applyEdit = (v: Json, edit: Edit): Json => {
  if (edit.kind === 'set') {
    const leaves = leafPaths(v)
    return leaves.length === 0 ? v : updateAt(v, leaves[edit.where % leaves.length] as string[], () => edit.value)
  }
  const arrays = arrayPaths(v)
  if (arrays.length === 0) return v
  const target = arrays[edit.where % arrays.length] as string[]
  return updateAt(v, target, (arr) => {
    const list = arr as Json[]
    if (edit.kind === 'insert') {
      const i = edit.where % (list.length + 1)
      return [...list.slice(0, i), edit.value, ...list.slice(i)]
    }
    if (list.length === 0) return list
    const i = edit.where % list.length
    return [...list.slice(0, i), ...list.slice(i + 1)]
  })
}


const disjoint = (a: readonly string[], b: readonly string[]): boolean => {
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) if (a[i] !== b[i]) return true
  return false // one is a prefix of the other: the write is inside what was read
}

describe('notification properties', () => {
  // both kinds of next state matter: an unrelated one (root sets, wholesale
  // replacement) and one edited out of prev (scoped sets, dels, splices)
  const statePair = jsonState.chain((prev) =>
    fc.oneof(
      jsonState.map((next) => [prev, next] as const),
      fc
        .array(fc.record({ kind: fc.constantFrom('set' as const, 'insert' as const, 'remove' as const), where: fc.nat(30), value: jsonValue }), { minLength: 1, maxLength: 4 })
        .map((edits) => [prev, edits.reduce(applyEdit, prev)] as const),
    ))

  it('a reader always wakes when what it read changed', () => {
    fc.assert(
      fc.property(statePair, fc.array(readPath, { minLength: 1, maxLength: 3 }), ([prev, next], paths) => {
        const src = source<Json>(prev as Json)
        let runs = 0
        let shown = ''
        const stop = effect(() => {
          runs++
          shown = project(src(), paths)
        })
        const before = shown
        src.publish(next as Json)
        flush()
        try {
          if (project(next, paths) !== before) expect(runs).toBe(2)
          expect(shown).toBe(project(next, paths)) // and it wakes with the right value
        } finally {
          stop()
        }
      }),
      { numRuns: 400 },
    )
  })

  it('a reader never wakes for a write that lands where it did not look', () => {
    fc.assert(
      fc.property(
        jsonState,
        fc.array(fc.nat(20), { minLength: 1, maxLength: 3 }),
        fc.nat(20),
        fc.integer({ min: 5, max: 9 }),
        (state, readSeeds, writeSeed, value) => {
          const leaves = leafPaths(state)
          fc.pre(leaves.length > 1)
          const paths = readSeeds.map((s) => leaves[s % leaves.length] as string[])
          const write = leaves[writeSeed % leaves.length] as string[]
          fc.pre(paths.every((p) => disjoint(p, write)))
          fc.pre(at(state, write) !== value) // an actual change, or nothing should wake anyway

          const src = source<Json>(state as Json)
          let runs = 0
          const stop = effect(() => {
            runs++
            void project(src(), paths)
          })
          src.publish(updateAt(state as Json, write, () => value))
          flush()
          try {
            expect(runs).toBe(1)
          } finally {
            stop()
          }
        },
      ),
      { numRuns: 400 },
    )
  })
})
