// The recording's pure parts, without a runtime: the ring's cut and fold,
// the reducer, clear, time travel, the tree, and event summarization.

import { describe, it, expect } from 'vitest'
import type { Patch, ProcessEvent } from '@nonchalant/core'
import { clear, empty, record, stateAt, type Draft, type Recording } from '../src/recording.ts'
import { cut, fold, trim } from '../src/ring.ts'
import { draft, summarizeOps } from '../src/summarize.ts'
import { tree } from '../src/tree.ts'

const spawned = (id: number, state: number | null = 0, parent: number | null = null): Draft =>
  ({ type: 'spawn', id, parent, name: `p${id}`, key: null, args: null, state: state === null ? null : { n: state } })
const yielded = (id: number, n: number): Draft => ({ type: 'yield', id, ops: [['set', '/n', n]] })
const run = (size: number, drafts: Draft[]): Recording => drafts.reduce(record, empty(size))

// ---------- the ring ----------

describe('cut', () => {
  it('drops nothing while the ring fits', () => {
    expect([cut(0, 8), cut(7, 8), cut(8, 8)]).toStrictEqual([0, 0, 0])
  })

  it('drops a quarter of the ring at once when it overflows by one', () => {
    expect([cut(9, 8), cut(11, 10), cut(2, 1)]).toStrictEqual([2, 3, 1])
  })

  it('drops everything over the size when that is more than a quarter', () => {
    expect(cut(20, 8)).toBe(12)
  })
})

describe('fold', () => {
  const rec = run(100, [spawned(1), yielded(1, 5)])

  it('folds a dropped yield into its process base and moves baseSeq to it', () => {
    const entry = rec.events[1]!
    const procs = fold(rec.procs, entry)
    expect({ base: procs[1]!.base, baseSeq: procs[1]!.baseSeq, state: procs[1]!.state }).toStrictEqual({ base: { n: 5 }, baseSeq: 2, state: { n: 5 } })
    expect(rec.procs[1]!.base).toStrictEqual({ n: 0 }) // the table it was given is untouched
  })

  it('forgets an ended process when its exit drops, and keeps a restarted one', () => {
    const ended = run(100, [spawned(1), { type: 'exit', id: 1, reason: 'done' }])
    expect(fold(ended.procs, ended.events[1]!)).toStrictEqual({})
    const restarted = run(100, [spawned(1), { type: 'exit', id: 1, reason: 'crashed' }, { type: 'restart', id: 1, attempt: 1 }])
    expect(fold(restarted.procs, restarted.events[1]!)).toBe(restarted.procs)
  })

  it('leaves the table alone for other entries and for unknown processes', () => {
    expect(fold(rec.procs, rec.events[0]!)).toBe(rec.procs)
    expect(fold(rec.procs, { type: 'yield', id: 9, ops: [], seq: 3 })).toBe(rec.procs)
  })
})

describe('trim', () => {
  it('returns the recording itself while it fits', () => {
    const rec = run(4, [spawned(1), yielded(1, 1)])
    expect(trim(rec)).toBe(rec)
  })

  it('drops the oldest quarter and folds what it drops, so the state still reconstructs', () => {
    const rec = run(4, [spawned(1), yielded(1, 1), yielded(1, 2), yielded(1, 3), yielded(1, 4)])
    expect(rec.events.map((e) => e.seq)).toStrictEqual([2, 3, 4, 5])
    expect({ base: rec.procs[1]!.base, baseSeq: rec.procs[1]!.baseSeq }).toStrictEqual({ base: { n: 0 }, baseSeq: 1 })
    const more = record(rec, yielded(1, 5))
    expect(more.events.map((e) => e.seq)).toStrictEqual([3, 4, 5, 6])
    expect({ base: more.procs[1]!.base, baseSeq: more.procs[1]!.baseSeq }).toStrictEqual({ base: { n: 1 }, baseSeq: 2 })
  })
})

// ---------- the reducer ----------

describe('record', () => {
  it('numbers entries from 1 and keeps status flips out of the timeline', () => {
    const rec = run(10, [spawned(1), { type: 'status', id: 1, pending: false, stale: true, errored: false }, yielded(1, 3)])
    expect(rec.events.map((e) => [e.seq, e.type])).toStrictEqual([[1, 'spawn'], [2, 'yield']])
    expect(rec.seq).toBe(2)
    const node = rec.procs[1]!
    expect([node.pending, node.stale, node.errored, node.state]).toStrictEqual([false, true, false, { n: 3 }])
  })

  it('moves a process through crashed, running and its exit reason', () => {
    const statuses: string[] = []
    let rec = run(10, [spawned(1)])
    for (const d of [{ type: 'crash', id: 1, error: 'x' }, { type: 'restart', id: 1, attempt: 1 }, { type: 'exit', id: 1, reason: 'disposed' }] as Draft[]) {
      rec = record(rec, d)
      statuses.push(rec.procs[1]!.status)
    }
    expect(statuses).toStrictEqual(['crashed', 'running', 'disposed'])
  })

  it('records an event for an unknown process without inventing a node', () => {
    const rec = run(10, [yielded(7, 1)])
    expect(rec.events).toHaveLength(1)
    expect(rec.procs).toStrictEqual({})
  })
})

describe('clear', () => {
  it('drops every entry and every ended process, rebasing the running ones on their current state', () => {
    const rec = run(10, [spawned(1), spawned(2), yielded(1, 4), { type: 'exit', id: 2, reason: 'done' }])
    const cleared = clear(rec)
    expect(cleared.events).toStrictEqual([])
    expect(Object.keys(cleared.procs)).toStrictEqual(['1'])
    expect({ base: cleared.procs[1]!.base, baseSeq: cleared.procs[1]!.baseSeq }).toStrictEqual({ base: { n: 4 }, baseSeq: 4 })
    expect(cleared.seq).toBe(4)
  })
})

// ---------- time travel ----------

describe('stateAt', () => {
  const rec = run(100, [spawned(1), spawned(2, 100), yielded(1, 1), yielded(2, 101), yielded(1, 2)])

  it('replays only that process’s yields up to the point asked', () => {
    expect([1, 2, 3, 4, 5].map((seq) => stateAt(rec, 1, seq))).toStrictEqual([{ n: 0 }, { n: 0 }, { n: 1 }, { n: 1 }, { n: 2 }])
    expect(stateAt(rec, 2, 4)).toStrictEqual({ n: 101 })
  })

  it('is undefined for an unknown process or a point before its base', () => {
    expect(stateAt(rec, 9, 5)).toBe(undefined)
    expect(stateAt(rec, 2, 1)).toBe(undefined)
  })

  it('starts from a spawn state of null', () => {
    expect(stateAt(run(10, [spawned(1, null)]), 1, 1)).toBe(null)
  })
})

// ---------- the tree ----------

describe('tree', () => {
  it('nests by parent, makes orphans roots, and leaves out the disposed', () => {
    const rec = run(100, [spawned(1), spawned(2, 0, 1), spawned(3, 0, 2), spawned(4, 0, 99), spawned(5, 0, 1), { type: 'exit', id: 5, reason: 'disposed' }])
    const shape = (ts: ReturnType<typeof tree>): unknown[] => ts.map((t) => [t.node.id, shape(t.children)])
    expect(shape(tree(rec.procs))).toStrictEqual([[1, [[2, [[3, []]]]]], [4, []]])
  })

  it('keeps a crashed or finished process in the tree', () => {
    const rec = run(100, [spawned(1), { type: 'exit', id: 1, reason: 'done' }, spawned(2), { type: 'crash', id: 2, error: 'x' }])
    expect(tree(rec.procs).map((t) => t.node.status)).toStrictEqual(['done', 'crashed'])
  })
})

// ---------- summarization ----------

describe('summarizeOps', () => {
  it('summarizes the values a patch writes and passes paths and deletes through', () => {
    const del: Patch[number] = ['del', '/gone']
    // a live patch carries whatever the app yielded, not only JSON
    const ops = summarizeOps([['set', '/f', () => 1], del, ['splice', '/xs', 0, 1, [undefined, 2]]] as unknown as Patch)
    expect(ops).toStrictEqual([['set', '/f', '[function anonymous]'], del, ['splice', '/xs', 0, 1, ['[undefined]', 2]]])
    expect(ops[1]).toBe(del)
  })
})

describe('draft', () => {
  it('makes a spawn plain: a missing key and state become null, args are summarized', () => {
    const e = { type: 'spawn', id: 3, parent: null, name: 'w', key: undefined, args: 10n, state: undefined } as unknown as ProcessEvent
    expect(draft(e)).toStrictEqual({ type: 'spawn', id: 3, parent: null, name: 'w', key: null, args: '10n', state: null })
  })

  it('turns a crash error into its label', () => {
    const e = { type: 'crash', id: 1, error: new TypeError('bad') } as unknown as ProcessEvent
    expect(draft(e)).toStrictEqual({ type: 'crash', id: 1, error: '[TypeError: bad]' })
  })
})
