// The cart is written with the reducer sugar. Two claims, asserted: its step is
// a plain function you test without a mailbox, and the Proc it compiles to
// behaves the same in this tab and across the wire.

import { describe, it, expect, vi } from 'vitest'
import { define, registry } from '@nonchalant/core'
import { connect, expose, memoryPair } from '@nonchalant/wire'
import { cart, cartStep, type CartState, type Shop } from './shared.ts'

const empty: CartState = { items: [], total: 0 }
// a call's reply is not ordered against the yields a remote read receives
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

const tea = { name: 'tea', price: 4 }
const cake = { name: 'cake', price: 6 }

describe('the cart step, as a function', () => {
  it('keeps the total in step with the items', () => {
    const s = cartStep(cartStep(empty, { type: 'add', item: tea }), { type: 'add', item: cake })
    expect(s).toStrictEqual({ items: [tea, cake], total: 10 })
    expect(cartStep(s, { type: 'remove', name: 'tea' })).toStrictEqual({ items: [cake], total: 6 })
  })

  it('returns the same state for a no-op, so the process yields nothing', () => {
    expect(cartStep(empty, { type: 'remove', name: 'tea' })).toBe(empty)
    expect(cartStep(empty, { type: 'checkout', reply: vi.fn() })).toBe(empty)
  })

  it('checkout answers with the charge and empties the cart', () => {
    const reply = vi.fn()
    const s = cartStep({ items: [tea], total: 4 }, { type: 'checkout', reply })
    expect(reply).toHaveBeenCalledWith({ ok: true, charged: 4 })
    expect(s).toStrictEqual(empty)
  })
})

describe('the cart process, here and there', () => {
  it('answers the same in a local registry and over the wire', async () => {
    const link = memoryPair()
    expose(registry({ cart: define(cart) }), link.host)
    const there = connect<Shop>(link.client).lookup('cart', { userId: 'u1' })
    const here = registry({ cart: define(cart) }).lookup('cart', { userId: 'u1' })

    for (const c of [here, there]) {
      c.cast({ type: 'add', item: tea })
      c.cast({ type: 'add', item: cake })
      expect(await c.call({ type: 'checkout' })).toStrictEqual({ ok: true, charged: 10 })
    }
    await settle()
    expect(here()).toStrictEqual(empty)
    expect(there()).toStrictEqual(empty)
  })
})
