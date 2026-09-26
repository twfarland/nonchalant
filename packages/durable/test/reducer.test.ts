// The reducer sugar under durable: a reducer's state is its whole snapshot, so
// a restored activation resumes from it instead of running init again.

import { describe, it, expect, vi } from 'vitest'
import { reducer, spawn } from '@nonchalant/core'
import type { Cast } from '@nonchalant/core'
import { durable, memoryStore } from '../src/index.ts'
import { settle } from './rig.ts'

type Msg = Cast<{ type: 'add'; n: number }>
type Sum = { total: number }

function sum(s: Sum, msg: Msg): Sum {
  switch (msg.type) {
    case 'add':
      return { total: s.total + msg.n }
  }
}

describe('a durable reducer', () => {
  it('resumes from the committed snapshot, not from init', async () => {
    const store = memoryStore()
    const init = vi.fn((): Sum => ({ total: 0 }))
    const opts = { store, key: (): string => 'sum' }

    const first = spawn(durable(reducer(init, sum), opts), undefined)
    first.cast({ type: 'add', n: 2 })
    first.cast({ type: 'add', n: 3 })
    await settle()
    expect(first()).toStrictEqual({ total: 5 })
    first[Symbol.dispose]()

    const second = spawn(durable(reducer(init, sum), opts), undefined)
    second.cast({ type: 'add', n: 10 })
    await settle()
    expect(second()).toStrictEqual({ total: 15 })
    expect(init).toHaveBeenCalledTimes(1) // only the first activation had nothing to restore
    second[Symbol.dispose]()
  })
})
