// The recording, headless: what inspect() keeps, the ring bound, and time
// travel — a reconstructed state equals the state the process really yielded.

import { describe, it, expect, afterEach } from 'vitest'
import fc from 'fast-check'
import { spawn } from '@nonchalant/core'
import type { Call, Cast, Json, Proc } from '@nonchalant/core'
import { inspect, summarize, type Inspector } from '@nonchalant/inspect'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await tick()
}

// ---------- a sample reducer ----------

type State = { items: number[]; meta: { count: number; label: string } }
type Msg =
  | Cast<{ type: 'push'; n: number }>
  | Cast<{ type: 'pop' }>
  | Cast<{ type: 'rename'; label: string }>
  | Call<{ type: 'size' }, number>

const initial: State = { items: [], meta: { count: 0, label: '' } }

const step = (s: State, msg: Exclude<Msg, { type: 'size' }>): State => {
  switch (msg.type) {
    case 'push': return { items: [...s.items, msg.n], meta: { ...s.meta, count: s.meta.count + 1 } }
    case 'pop': return { ...s, items: s.items.slice(0, -1) }
    case 'rename': return { ...s, meta: { ...s.meta, label: msg.label } }
  }
}

const listProc: Proc<State, Msg, void> = async function* listBody(self) {
  let state = initial
  for await (const msg of self) {
    switch (msg.type) {
      case 'size':
        msg.reply(state.items.length)
        continue
      case 'push':
      case 'pop':
      case 'rename':
        state = step(state, msg)
        break
    }
    yield state
  }
}

let open: Inspector | undefined
afterEach(() => {
  open?.[Symbol.dispose]()
  open = undefined
})
const start = (size?: number): Inspector => (open = inspect(size === undefined ? {} : { size }))

// ---------- recording ----------

describe('inspect', () => {
  it('records spawn, messages, yields, replies and exit as timeline entries, in order', async () => {
    const insp = start()
    const p = spawn(listProc, undefined, { initial })
    p.cast({ type: 'push', n: 7 })
    expect(await p.call({ type: 'size' })).toBe(1)
    p[Symbol.dispose]()
    await settle()
    expect(insp.timeline().map((e) => [e.seq, e.type])).toEqual([
      [1, 'spawn'], [2, 'cast'], [3, 'call'], [4, 'yield'], [5, 'reply'], [6, 'exit'],
    ])
    const [spawned, cast, call, yielded, reply] = insp.timeline()
    expect(spawned).toMatchObject({ name: 'listBody', parent: null, key: null, args: '[undefined]', state: initial })
    expect(cast).toMatchObject({ msg: { type: 'push', n: 7 } })
    expect(call).toMatchObject({ msg: { type: 'size' } })
    expect(reply).toMatchObject({ value: 1, call: (call as { call: number }).call })
    expect(yielded).toMatchObject({ ops: [['splice', '/items', 0, 0, [7]], ['set', '/meta/count', 1]] })
  })

  it('records none of its own processes', async () => {
    const insp = start()
    const p = spawn(listProc, undefined, { initial })
    p.cast({ type: 'push', n: 1 })
    await settle()
    const ids = new Set(insp.timeline().map((e) => e.id))
    expect([...ids]).toHaveLength(1)
    expect(Object.keys(insp.recording().procs)).toHaveLength(1)
    p[Symbol.dispose]()
  })

  it('nests the tree by ownership and tracks status flags', async () => {
    const insp = start()
    const child: Proc<number, never, void> = async function* childBody() {
      yield 1
      await new Promise(() => {})
    }
    const parentProc: Proc<number, Cast<{ type: 'fail' }>, void> = async function* parentBody(self) {
      spawn(child, undefined)
      yield 0
      for await (const msg of self) throw new Error(`nope: ${msg.type}`)
    }
    const parent = spawn(parentProc, undefined)
    await settle()
    expect(insp.tree().map((t) => [t.node.name, t.node.pending, t.children.map((c) => c.node.name)]))
      .toEqual([['parentBody', false, ['childBody']]])
    parent.cast({ type: 'fail' })
    await settle()
    const [root] = insp.tree()
    expect(root?.node).toMatchObject({ name: 'parentBody', status: 'crashed', stale: true, errored: true })
    // the crashed instance's child died with it
    expect(root?.children).toEqual([])
    expect(insp.timeline().filter((e) => e.type === 'crash')).toMatchObject([{ error: '[Error: nope: fail]' }])
    parent[Symbol.dispose]()
    await settle()
    expect(insp.tree()).toEqual([])
  })

  it('keeps at most `size` entries, dropping the oldest', async () => {
    const insp = start(8)
    const p = spawn(listProc, undefined, { initial })
    for (let i = 0; i < 20; i++) p.cast({ type: 'push', n: i })
    await settle()
    const seqs = insp.timeline().map((e) => e.seq)
    expect(seqs.length).toBeLessThanOrEqual(8)
    expect(seqs.at(-1)).toBe(41) // spawn + 20 casts + 20 yields
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i))
    expect(insp.recording().procs[insp.timeline()[0]!.id]?.state).toEqual({
      items: Array.from({ length: 20 }, (_, i) => i),
      meta: { count: 20, label: '' },
    })
    p[Symbol.dispose]()
  })

  it('forgets a disposed process once its exit leaves the ring', async () => {
    const insp = start(4)
    const a = spawn(listProc, undefined, { initial })
    a[Symbol.dispose]()
    const b = spawn(listProc, undefined, { initial })
    for (let i = 0; i < 6; i++) b.cast({ type: 'pop' })
    await settle()
    expect(Object.values(insp.recording().procs).map((n) => n.status)).toEqual(['running'])
    b[Symbol.dispose]()
  })

  it('stops recording once disposed', async () => {
    const insp = inspect()
    insp[Symbol.dispose]()
    const p = spawn(listProc, undefined, { initial })
    await settle()
    expect(insp.recording().events).toEqual([])
    p[Symbol.dispose]()
  })
})

// ---------- time travel ----------

describe('time travel', () => {
  const msgArb: fc.Arbitrary<Exclude<Msg, { type: 'size' }>> = fc.oneof(
    fc.integer({ min: -5, max: 5 }).map((n) => ({ type: 'push' as const, n })),
    fc.constant({ type: 'pop' as const }),
    fc.string({ maxLength: 3 }).map((label) => ({ type: 'rename' as const, label })),
  )

  it('reconstructs the exact state each yield produced, even after the ring drops history', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(msgArb, { minLength: 1, maxLength: 30 }), fc.integer({ min: 3, max: 40 }), async (msgs, size) => {
        const insp = inspect({ size })
        try {
          const p = spawn(listProc, undefined, { initial })
          const expected: State[] = []
          let s = initial
          for (const m of msgs) {
            p.cast(m)
            s = step(s, m)
            expected.push(s)
          }
          await settle()
          const id = insp.timeline().at(-1)!.id
          const yields = insp.timeline().filter((e) => e.type === 'yield')
          const skipped = expected.length - yields.length
          yields.forEach((e, j) => expect(insp.stateAt(id, e.seq)).toEqual(expected[skipped + j]))
          expect(insp.recording().procs[id]?.state).toEqual(s)
          expect(insp.timeline().length).toBeLessThanOrEqual(size)
          p[Symbol.dispose]()
        } finally {
          insp[Symbol.dispose]()
        }
      }),
      { numRuns: 60 },
    )
  }, 30_000)

  it('answers undefined for a point older than what the ring retains', async () => {
    const insp = start(4)
    const p = spawn(listProc, undefined, { initial })
    for (let i = 0; i < 10; i++) p.cast({ type: 'push', n: i })
    await settle()
    const id = insp.timeline()[0]!.id
    expect(insp.stateAt(id, 1)).toBeUndefined()
    p[Symbol.dispose]()
  })
})

// ---------- summaries ----------

describe('summarize', () => {
  it('returns plain JSON by reference and labels everything else', () => {
    const plain: Json = { a: [1, { b: 'c' }] }
    expect(summarize(plain)).toBe(plain)
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(summarize({
      f: function named() {},
      u: undefined,
      n: Number.NaN,
      d: new Date(0),
      m: new Map(),
      e: new TypeError('bad'),
      big: 2n,
      c: cyclic,
    })).toEqual({
      f: '[function named]',
      u: '[undefined]',
      n: 'NaN',
      d: '1970-01-01T00:00:00.000Z',
      m: '[Map]',
      e: '[TypeError: bad]',
      big: '2n',
      c: { self: '[cycle]' },
    })
    expect(() => structuredClone(summarize({ f: () => {} }))).not.toThrow()
  })
})
