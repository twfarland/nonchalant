// Idiomatic process testing, demonstrated (the doc is docs/testing.md).
//
// The trick: `Self` is an interface and `channel()` is a real one — so a
// process can be tested as the plain async generator it is. No runtime, no
// timers, no DOM: script the mailbox, await the yields, assert the
// transcript. Pure helpers stay pure and test as functions.

import { describe, it, expect } from 'vitest'
import { channel } from '@nonchalant/core'
import type { Proc } from '@nonchalant/core'
import { remaining, todosProc, visible, type Msg, type State } from './todos.ts'

/** Drive a proc through a scripted mailbox; return the transcript of yields. */
const transcript = async <T, In>(proc: Proc<T, In, void>, msgs: In[]): Promise<T[]> => {
  const self = channel<In>()
  for (const msg of msgs) self.send(msg) // FIFO: queued until the body reads
  const it = proc(self, undefined)
  const out: T[] = []
  for (let i = 0; i < msgs.length; i++) out.push((await it.next()).value as T)
  await it.return?.(undefined)
  return out
}

describe('the todos process, driven directly', () => {
  it('yields one state per message, in order', async () => {
    const states = await transcript(todosProc, [
      { type: 'add', title: 'milk' },
      { type: 'add', title: 'bread' },
      { type: 'toggle', id: 1 },
    ] as Msg[])

    expect(states.map((s) => s.todos.map((t) => `${t.title}:${t.done ? 'x' : 'o'}`))).toEqual([
      ['milk:o'],
      ['milk:o', 'bread:o'],
      ['milk:x', 'bread:o'],
    ])
  })

  it('toggle-all is idempotent on already-done items (identity preserved)', async () => {
    const states = await transcript(todosProc, [
      { type: 'add', title: 'a' },
      { type: 'toggle', id: 1 },
      { type: 'add', title: 'b' },
      { type: 'toggle-all', done: true },
    ] as Msg[])

    const before = states[2]!.todos[0]!
    const after = states[3]!.todos[0]!
    expect(after.done).toBe(true)
    expect(after).toBe(before) // untouched items keep identity — reconcile stays O(changed)
  })

  it('clear-completed keeps only active todos', async () => {
    const states = await transcript(todosProc, [
      { type: 'add', title: 'keep' },
      { type: 'add', title: 'drop' },
      { type: 'toggle', id: 2 },
      { type: 'clear-completed' },
    ] as Msg[])

    expect(states[3]!.todos.map((t) => t.title)).toEqual(['keep'])
  })
})

describe('the pure helpers, as plain functions', () => {
  const state: State = {
    todos: [
      { id: 1, title: 'a', done: true },
      { id: 2, title: 'b', done: false },
    ],
    filter: 'active',
  }

  it('visible applies the filter', () => {
    expect(visible(state).map((t) => t.title)).toEqual(['b'])
    expect(visible({ ...state, filter: 'completed' }).map((t) => t.title)).toEqual(['a'])
    expect(visible({ ...state, filter: 'all' })).toHaveLength(2)
  })

  it('remaining counts active todos', () => {
    expect(remaining(state)).toBe(1)
  })
})
