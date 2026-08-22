// The isomorphic module: one process definition, one typed schema. Both the
// tab and the server import THIS file — the process does not know which side
// of the wire it runs on.

import type { Call, Definition, Proc } from '@nonchalant/core'

export type Item = { name: string; price: number }
export type CartState = { items: Item[]; total: number }
export type CartMsg =
  | { type: 'add'; item: Item }
  | { type: 'remove'; name: string }
  | Call<{ type: 'checkout' }, { ok: boolean; charged: number }>

export const cart: Proc<CartState, CartMsg, { userId: string }> = async function* (self) {
  let items: Item[] = []
  const total = (): number => items.reduce((sum, it) => sum + it.price, 0)
  yield { items, total: 0 }
  for await (const msg of self) {
    if (msg.type === 'add') items = [...items, msg.item]
    else if (msg.type === 'remove') items = items.filter((it) => it.name !== msg.name)
    else {
      msg.reply({ ok: true, charged: total() })
      items = []
    }
    yield { items, total: total() }
  }
}

export type Shop = { cart: Definition<CartState, CartMsg, { userId: string }> }
