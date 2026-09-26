// The isomorphic module: one process definition, one typed schema. Both the
// tab and the server import THIS file — the process does not know which side
// of the wire it runs on.
//
// The cart is written with `reducer`, the optional sugar for a process that
// only folds messages into state. It compiles to the same Proc a hand-written
// generator would be, so define, connect, and call() cannot tell the
// difference.

import { reducer } from '@nonchalant/core'
import type { Call, Cast, Definition } from '@nonchalant/core'

export type Item = { name: string; price: number }
export type CartState = { items: Item[]; total: number }
export type CartMsg =
  | Cast<{ type: 'add'; item: Item }>
  | Cast<{ type: 'remove'; name: string }>
  | Call<{ type: 'checkout' }, { ok: boolean; charged: number }>

const priced = (items: Item[]): CartState => ({ items, total: items.reduce((sum, it) => sum + it.price, 0) })

export function cartStep(s: CartState, msg: CartMsg): CartState {
  switch (msg.type) {
    case 'add':
      return priced([...s.items, msg.item])
    case 'remove': {
      const items = s.items.filter((it) => it.name !== msg.name)
      return items.length === s.items.length ? s : priced(items)
    }
    case 'checkout':
      msg.reply({ ok: true, charged: s.total })
      return s.items.length === 0 ? s : priced([])
  }
}

export const cart = reducer((_: { userId: string }) => priced([]), cartStep)

export type Shop = { cart: Definition<CartState, CartMsg, { userId: string }> }
