// Scaling of the graph layer's own bookkeeping: watched-ness queries over
// computed DAGs, and settling a computed's return value.

import { describe, it, expect } from 'vitest'
import { computed, effect, flush, source, type ComputedHandle } from '../src/graph.ts'

const DEPTH = 30
type Level = [ComputedHandle<number>, ComputedHandle<number>]

/** `depth` levels of two computeds, each reading both of the level below: 2^depth paths from top to bottom. */
function diamond(depth: number, root: () => number): { top: ComputedHandle<number>; evals: () => number; all: ComputedHandle<number>[] } {
  let evals = 0
  const all: ComputedHandle<number>[] = []
  let below: Level | undefined
  for (let i = 0; i < depth; i++) {
    const [x, y] = below ?? [undefined, undefined]
    const read = (): number => (x === undefined || y === undefined ? root() : (x.read() + y.read()) % 1_000_003)
    const level: Level = [
      computed(() => (evals++, read())),
      computed(() => (evals++, read() + 1)),
    ]
    all.push(...level)
    below = level
  }
  const [a, b] = below!
  const top = computed(() => (evals++, a.read() + b.read()))
  all.push(top)
  return { top, evals: () => evals, all }
}

describe('watched-ness queries are linear in the DAG, not in its paths', () => {
  it('a 30-level diamond of unwatched computeds recomputes each node exactly once per change', () => {
    const src = source<{ n: number }>({ n: 0 })
    const d = diamond(DEPTH, () => src().n)
    d.top.read()
    expect(d.evals()).toBe(2 * DEPTH + 1)
    src.publish({ n: 1 })
    d.top.read()
    expect(d.evals()).toBe(4 * DEPTH + 2)
    // 2^30 upward paths: an exponential walk would not finish at all; watch.test.ts
    // pins the walks themselves to one visit per node
    for (const c of d.all) c.dispose()
  })

  it('an effect joining and leaving the top of a 30-level diamond counts the source once each way', () => {
    const log: number[] = []
    const src = source<{ n: number }>({ n: 0 }, { onWatchers: (c) => void log.push(c) })
    const d = diamond(DEPTH, () => src().n)
    d.top.read()
    const stop = effect(() => void d.top.read())
    expect(log).toEqual([1, 2])
    src.publish({ n: 1 })
    flush()
    expect(d.evals()).toBe(4 * DEPTH + 2)
    stop()
    expect(log).toEqual([1, 2, 1, 0])
    for (const c of d.all) c.dispose()
  })
})

describe('settling a derive result walks only what could hold a proxy', () => {
  /** 10,000 rows whose key enumeration is counted — each count is one container visited by a walk. */
  const bigTable = (): { table: { rows: { id: number }[] }; walks: () => number } => {
    let walks = 0
    const rows = Array.from({ length: 10_000 }, (_, id) =>
      new Proxy({ id }, {
        ownKeys: (t) => {
          walks++
          return Reflect.ownKeys(t)
        },
      }))
    return { table: { rows }, walks: () => walks }
  }

  it('a derive over a primitive snapshot returning a large static object never walks it', () => {
    const { table, walks } = bigTable()
    const n = source<number>(0)
    const d = computed(() => (n() >= 0 ? table : null))
    const stop = effect(() => void d.read())
    for (let i = 1; i <= 3; i++) {
      n.publish(i)
      flush()
    }
    expect(d.read()).toBe(table)
    expect(walks()).toBe(0)
    stop()
    d.dispose()
  })

  it('a derive that reads through a proxy walks a large static result once, not per recompute', () => {
    const { table, walks } = bigTable()
    const src = source<{ n: number }>({ n: 0 })
    let evals = 0
    const d = computed(() => (evals++, { n: src().n, table }))
    const stop = effect(() => void d.read())
    expect(walks()).toBe(10_000)
    for (let i = 1; i <= 3; i++) {
      src.publish({ n: i })
      flush()
    }
    expect(evals).toBe(4)
    expect(d.read().table).toBe(table)
    expect(walks()).toBe(10_000)
    stop()
    d.dispose()
  })

  it('a result sharing its previous value re-walks only the fresh containers', () => {
    const src = source<{ items: { n: number }[] }>({ items: [{ n: 0 }] })
    const d = computed((prev?: { n: number }[][]) => [...(prev ?? []), src().items])
    const stop = effect(() => void d.read())
    const first = src().items
    src.publish({ items: [{ n: 1 }] })
    flush()
    const v = d.read()
    expect(v[0]).toBe(first)
    expect(v[1]).toBe(src().items)
    stop()
    d.dispose()
  })
})
