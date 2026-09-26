// Watched-ness over hand-linked nodes. Computeds here count their own stamp
// writes (accessor properties), so each walk's visits are exact: that is what
// proves the walks linear in nodes on a DAG with 2^30 paths, without a clock.

import { describe, it, expect } from 'vitest'
import { count, isWatched, rewatch, type Counted, type Stamped } from '../src/watch.ts'
import { createReactiveSystem, WATCHING, type ReactiveNode } from '../src/system.ts'

const { link } = createReactiveSystem({ update: () => false, notify: () => {}, unwatched: () => {} })

const bare = (): Pick<ReactiveNode, 'deps' | 'depsTail' | 'subs' | 'subsTail'> =>
  ({ deps: undefined, depsTail: undefined, subs: undefined, subsTail: undefined })

type Comp = Stamped & { getter: () => void; visits: number; sweeps: number }

function comp(): Comp {
  let seen = 0
  let swept = 0
  const node: Comp = {
    ...bare(),
    flags: 0,
    getter: () => {},
    visits: 0,
    sweeps: 0,
    get seen() { return seen },
    set seen(v: number) { seen = v; node.visits++ },
    get swept() { return swept },
    set swept(v: number) { swept = v; node.sweeps++ },
  }
  return node
}

const fx = (): ReactiveNode & { fn: () => void } => ({ ...bare(), flags: WATCHING, fn: () => {} })

function source(): { watched: number; onWatchers: (n: number) => void; log: number[] } {
  const log: number[] = []
  return { watched: 0, log, onWatchers: (n) => void log.push(n) }
}

type GateNode = ReactiveNode & { gate: Counted }

const gateNode = (src: Counted['source']): GateNode => ({ ...bare(), flags: 1, gate: { counted: false, source: src } })

/** `depth` levels of two computeds, each reading both of the level below, over one gate per bottom reader. */
function diamond(depth: number, src: Counted['source']): { top: Comp; all: Comp[]; bottom: Comp[]; gates: GateNode[] } {
  const all: Comp[] = []
  let below: Comp[] = []
  let bottom: Comp[] = []
  const gates: GateNode[] = []
  for (let i = 0; i < depth; i++) {
    const level = [comp(), comp()]
    for (const c of level) {
      if (i === 0) {
        const g = gateNode(src)
        gates.push(g)
        link(g, c, 0)
      } else {
        for (const d of below) link(d, c, 0)
      }
    }
    if (i === 0) bottom = level
    all.push(...level)
    below = level
  }
  const top = comp()
  for (const d of below) link(d, top, 0)
  all.push(top)
  return { top, all, bottom, gates }
}

const DEPTH = 30

describe('isWatched', () => {
  it('an effect is watched until disposed (flags 0)', () => {
    const e = fx()
    expect(isWatched(e)).toBe(true)
    e.flags = 0
    expect(isWatched(e)).toBe(false)
  })

  it('a computed is watched through any chain of computeds that ends in a live effect', () => {
    const a = comp(), b = comp(), e = fx()
    link(a, b, 0)
    expect(isWatched(a)).toBe(false)
    link(b, e, 0)
    expect(isWatched(a)).toBe(true)
    e.flags = 0
    expect(isWatched(a)).toBe(false)
  })

  it('a query over an unwatched 30-level diamond visits each node exactly once', () => {
    const { all, bottom } = diamond(DEPTH, source())
    expect(isWatched(bottom[0]!)).toBe(false)
    // everything above bottom[0]: its level-0 sibling is not upstream of it
    const reached = all.filter((c) => c !== bottom[1])
    expect(reached.map((c) => c.visits)).toEqual(reached.map(() => 1))
    expect(bottom[1]!.visits).toBe(0)
  })

  it('a second query stamps again: answers are never cached across queries', () => {
    const { top, all } = diamond(DEPTH, source())
    isWatched(all[0]!)
    link(top, fx(), 0)
    expect(isWatched(all[0]!)).toBe(true)
  })
})

describe('count', () => {
  it('reports the new total on each change and nothing on a repeat', () => {
    const src = source()
    const a: Counted = { counted: false, source: src }
    const b: Counted = { counted: false, source: src }
    count(a, true)
    count(a, true)
    count(b, true)
    count(a, false)
    count(a, false)
    count(b, false)
    expect(src.log).toEqual([1, 2, 1, 0])
    expect(src.watched).toBe(0)
  })

  it('keeps no total for a source nobody listens to, but still flips the gate', () => {
    const s = { watched: 0, onWatchers: undefined }
    const g: Counted = { counted: false, source: s }
    count(g, true)
    expect(g.counted).toBe(true)
    expect(s.watched).toBe(0)
  })
})

describe('rewatch', () => {
  it('counts every gate beneath a computed gaining a watched path, visiting each computed once', () => {
    const src = source()
    const { top, all, gates } = diamond(DEPTH, src)
    rewatch(top, true)
    expect(gates.map((g) => g.gate.counted)).toEqual([true, true])
    expect(src.log).toEqual([1, 2])
    const beneath = all.filter((c) => c !== top)
    expect(beneath.map((c) => c.sweeps)).toEqual(beneath.map(() => 1))
    expect(top.sweeps).toBe(0)
  })

  it('uncounts the gates beneath a computed losing its last watched path', () => {
    const src = source()
    const { top, all, gates } = diamond(DEPTH, src)
    rewatch(top, true)
    rewatch(top, false)
    expect(gates.map((g) => g.gate.counted)).toEqual([false, false])
    expect(src.log).toEqual([1, 2, 1, 0])
    const beneath = all.filter((c) => c !== top)
    expect(beneath.map((c) => c.sweeps)).toEqual(beneath.map(() => 2))
  })

  it('keeps counting a gate still watched through another reader', () => {
    const src = source()
    const g = gateNode(src)
    const shared = comp(), left = comp(), right = comp()
    link(g, shared, 0)
    link(shared, left, 0)
    link(shared, right, 0)
    link(right, fx(), 0)
    rewatch(left, true)
    expect(src.log).toEqual([1])
    rewatch(left, false)
    // shared is still watched through right: the walk stops there
    expect(g.gate.counted).toBe(true)
    expect(src.log).toEqual([1])
  })
})
