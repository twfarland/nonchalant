// Durable calls: the half that makes a durable process worth calling. An
// answer is recorded under the caller's idempotency key, so a retry — after
// the caller crashed, after the callee crashed, or from two places at once —
// gets the answer back instead of causing the work to happen twice.

import { describe, it, expect } from 'vitest'
import { spawn } from '@nonchalant/core'
import type { Call, Cast } from '@nonchalant/core'
import { durable, memoryStore, type DurableProc, type Store } from '../src/index.ts'

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const settle = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await tick()
}

type Vault = { reserved: number; receipts: string[] }
type VaultMsg =
  | Cast<{ type: 'clear' }>
  | Call<{ type: 'reserve'; amount: number; callId: string }, string>

let worked = 0

const vault: DurableProc<Vault, VaultMsg, { id: string }> = async function* (self, _args, d) {
  let s: Vault = d.restored ?? { reserved: 0, receipts: [] }
  yield s
  for await (const msg of self) {
    switch (msg.type) {
      case 'clear':
        s = { reserved: 0, receipts: [] }
        yield s
        break
      case 'reserve': {
        const receipt = await d.step('reserve', () => {
          worked++
          return `receipt-${worked}`
        })
        s = { reserved: s.reserved + msg.amount, receipts: [...s.receipts, receipt] }
        msg.reply(receipt)
        yield s
        break
      }
    }
  }
}

const open = (store: Store, id: string) =>
  spawn(durable(vault, { store, key: (a: { id: string }) => a.id }), { id })

describe('durable calls', () => {
  it('answers a repeated call from the record instead of doing the work again', async () => {
    worked = 0
    const store = memoryStore()
    const p = open(store, 'v1')

    const first = await p.call({ type: 'reserve', amount: 10, callId: 'order-7' })
    const second = await p.call({ type: 'reserve', amount: 10, callId: 'order-7' })
    await settle()

    expect(first).toBe('receipt-1')
    expect(second).toBe('receipt-1') // the same answer, not a new one
    expect(worked).toBe(1)
    expect(p()?.reserved).toBe(10) // and the state moved once
    p[Symbol.dispose]()
  })

  it('a different id is a different call', async () => {
    worked = 0
    const store = memoryStore()
    const p = open(store, 'v2')
    expect(await p.call({ type: 'reserve', amount: 1, callId: 'a' })).toBe('receipt-1')
    expect(await p.call({ type: 'reserve', amount: 1, callId: 'b' })).toBe('receipt-2')
    await settle() // a reply lands before the yield that follows it
    expect(p()?.reserved).toBe(2)
    p[Symbol.dispose]()
  })

  it('two callers asking the same id at once wait on one answer', async () => {
    worked = 0
    const store = memoryStore()
    const p = open(store, 'v3')

    const both = await Promise.all([
      p.call({ type: 'reserve', amount: 4, callId: 'same' }),
      p.call({ type: 'reserve', amount: 4, callId: 'same' }),
    ])
    await settle()

    expect(both).toStrictEqual(['receipt-1', 'receipt-1'])
    expect(worked).toBe(1)
    expect(p()?.reserved).toBe(4)
    p[Symbol.dispose]()
  })

  it('survives the callee dying between answering and acknowledging', async () => {
    worked = 0
    const store = memoryStore()
    // let the answer be recorded, then refuse the commit that would acknowledge it
    const brittle: Store = { ...store, commit: async () => { throw new Error('CRASH') } }

    const dying = spawn(durable(vault, { store: brittle, key: (a: { id: string }) => a.id }), { id: 'v4' })
    expect(await dying.call({ type: 'reserve', amount: 3, callId: 'order-9' })).toBe('receipt-1')
    dying.cast({ type: 'clear' }) // provokes the commit, which crashes the process
    await settle()
    expect(dying.error).toBeInstanceOf(Error)
    dying[Symbol.dispose]()

    const back = open(store, 'v4')
    await settle()
    expect(worked).toBe(1) // the unacknowledged call was answered already: not handled again
    expect(await back.call({ type: 'reserve', amount: 3, callId: 'order-9' })).toBe('receipt-1')
    expect(worked).toBe(1)
    back[Symbol.dispose]()
  })
})

// ---------- the caller's half ----------

type Job = { stage: string; receipt: string }
type JobMsg = Cast<{ type: 'go'; amount: number }>

const caller = (bank: ReturnType<typeof open>, onStep: () => void): DurableProc<Job, JobMsg, { id: string }> =>
  async function* (self, _args, d) {
    let s: Job = d.restored ?? { stage: 'new', receipt: '' }
    yield s
    for await (const msg of self) {
      // one journaled call: the id is derived, so a replay calls with the same one
      const receipt = await d.call('reserve', (callId) =>
        bank.call({ type: 'reserve', amount: msg.amount, callId }))
      onStep()
      s = { stage: 'reserved', receipt }
      yield s
    }
  }

describe('d.call across two durable processes', () => {
  it('a caller that dies after the answer does not make the callee work twice', async () => {
    worked = 0
    const bankStore = memoryStore()
    const bank = open(bankStore, 'bank')
    await settle()

    // this caller loses its step journal and dies before it can acknowledge the
    // message — the worst case, and the one the callee's record is there for
    const callerStore = memoryStore()
    const brittle: Store = {
      ...callerStore,
      putStep: async () => {},
      commit: async () => { throw new Error('CRASH') },
    }

    let steps = 0
    const first = spawn(
      durable(caller(bank, () => steps++), { store: brittle, key: (a: { id: string }) => a.id }),
      { id: 'job' },
    )
    first.cast({ type: 'go', amount: 5 })
    await settle()
    expect(first()?.receipt).toBe('receipt-1')
    expect(worked).toBe(1)
    expect(first.error).toBeInstanceOf(Error) // it died acknowledging
    first[Symbol.dispose]()

    // nothing was recorded, so the restart replays the message and the call
    const second = spawn(
      durable(caller(bank, () => steps++), { store: callerStore, key: (a: { id: string }) => a.id }),
      { id: 'job' },
    )
    await settle()
    expect(second()?.receipt).toBe('receipt-1') // the same receipt came back
    expect(worked).toBe(1) // and the bank did not reserve twice
    expect(steps).toBe(2) // the caller re-ran its own turn, as at-least-once promises
    second[Symbol.dispose]()
    bank[Symbol.dispose]()
  })
})
