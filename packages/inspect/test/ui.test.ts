// The panel's headless half: the tree's key reducer as a table, entry and
// process text, and the selection process.

import { describe, it, expect } from 'vitest'
import { spawn, flush } from '@nonchalant/core'
import type { ProcNode } from '../src/recording.ts'
import { brief, describe as line, label, treeKey, uiProc, type TreeAction } from '../src/ui.ts'

describe('treeKey', () => {
  const table: [key: string, at: number, count: number, action: TreeAction | null][] = [
    ['ArrowDown', 0, 3, { type: 'focus', index: 1 }],
    ['ArrowDown', 2, 3, { type: 'focus', index: 2 }], // clamped at the last
    ['ArrowDown', -1, 3, { type: 'focus', index: 0 }], // from nowhere to the first
    ['ArrowUp', 2, 3, { type: 'focus', index: 1 }],
    ['ArrowUp', 0, 3, { type: 'focus', index: 0 }], // clamped at the first
    ['ArrowUp', -1, 3, { type: 'focus', index: 0 }],
    ['Home', 2, 3, { type: 'focus', index: 0 }],
    ['End', 0, 3, { type: 'focus', index: 2 }],
    ['ArrowDown', -1, 0, null], // an empty tree has nothing to focus
    ['End', -1, 0, null],
    ['Enter', 1, 3, { type: 'select' }],
    [' ', 1, 3, { type: 'select' }],
    ['Enter', -1, 0, { type: 'select' }],
    ['Tab', 1, 3, null], // not the tree's: the browser keeps it
    ['a', 1, 3, null],
    ['ArrowLeft', 1, 3, null],
  ]
  for (const [key, at, count, action] of table) {
    it(`${JSON.stringify(key)} from ${at} of ${count} → ${JSON.stringify(action)}`, () => {
      expect(treeKey(key, at, count)).toStrictEqual(action)
    })
  }
})

describe('brief', () => {
  it('writes JSON on one line and cuts it at 80 characters', () => {
    expect(brief({ a: [1, 'x'] })).toBe('{"a":[1,"x"]}')
    const long = brief('x'.repeat(100))
    expect([long.length, long.endsWith('…')]).toStrictEqual([80, true])
    expect(brief('x'.repeat(78))).toHaveLength(80) // quotes included, exactly at the limit
  })
})

describe('describe', () => {
  it('gives one line per kind of entry', () => {
    expect([
      line({ type: 'spawn', id: 1, parent: null, name: 'n', key: 'cart', args: { id: 1 }, state: null, seq: 1 }),
      line({ type: 'spawn', id: 1, parent: null, name: 'n', key: null, args: null, state: null, seq: 1 }),
      line({ type: 'cast', id: 1, msg: { type: 'inc' }, seq: 2 }),
      line({ type: 'call', id: 1, msg: 'q', call: 4, seq: 3 }),
      line({ type: 'reply', id: 1, call: 4, value: 7, seq: 4 }),
      line({ type: 'yield', id: 1, ops: [['del', '/a']], seq: 5 }),
      line({ type: 'yield', id: 1, ops: [], seq: 6 }),
      line({ type: 'crash', id: 1, error: '[Error: x]', seq: 7 }),
      line({ type: 'restart', id: 1, attempt: 2, seq: 8 }),
      line({ type: 'exit', id: 1, reason: 'done', seq: 9 }),
    ]).toStrictEqual([
      'spawn as cart {"id":1}', 'spawn null', 'cast {"type":"inc"}', 'call #4 "q"', 'reply #4 7',
      'yield 1 op', 'yield 0 ops', 'crash [Error: x]', 'restart 2', 'exit done',
    ])
  })
})

describe('label', () => {
  const node = (key: string | null, name: string): ProcNode => ({
    id: 1, parent: null, name, key, status: 'running', pending: false, stale: false, errored: false, state: null, base: null, baseSeq: 1,
  })

  it('prefers the registry key, then the name, then says anonymous', () => {
    expect([label(node('cart', 'shop')), label(node(null, 'shop')), label(node(null, ''))]).toStrictEqual(['cart', 'shop', 'anonymous'])
  })
})

describe('uiProc', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    flush()
  }

  it('selecting a process clears the pick; picking keeps the selection; repeats change nothing', async () => {
    const ui = spawn(uiProc, undefined, { initial: { selected: null, picked: null } })
    const seen: unknown[] = []
    ui.cast({ type: 'pick', seq: 3 })
    await settle()
    seen.push(ui())
    ui.cast({ type: 'select', id: 2 })
    await settle()
    seen.push(ui())
    ui.cast({ type: 'pick', seq: 5 })
    await settle()
    const before = ui()
    ui.cast({ type: 'pick', seq: 5 })
    ui.cast({ type: 'select', id: 2 })
    await settle()
    expect(ui()).toBe(before)
    seen.push(before)
    expect(seen).toStrictEqual([{ selected: null, picked: 3 }, { selected: 2, picked: null }, { selected: 2, picked: 5 }])
    ui[Symbol.dispose]()
  })
})
