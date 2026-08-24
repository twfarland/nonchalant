// `lookup(name, args)` is get-or-spawn: the first caller starts the process,
// every later caller gets the same one. These two panels were built
// independently and never introduced to each other — they share state because
// they asked for the same name. Swap `registry` for `connect(transport)` and
// the same code reads a process on a server.

import { define, registry } from '@nonchalant/core'
import type { Cast, Proc, Process, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, li, span, ul } from '@nonchalant/dom/tags'

type Cart = { items: string[]; total: number }
type Msg = Cast<{ type: 'add'; item: string; price: number }> | Cast<{ type: 'clear' }>

const cart: Proc<Cart, Msg, { userId: string }> = async function* (self) {
  let s: Cart = { items: [], total: 0 }
  yield s
  for await (const msg of self) {
    switch (msg.type) {
      case 'add':
        s = { items: [...s.items, msg.item], total: s.total + msg.price }
        break
      case 'clear':
        s = { items: [], total: 0 }
        break
    }
    yield s
  }
}

const shop = registry({ cart: define(cart, { initial: { items: [], total: 0 } }) })

const STOCK: [item: string, price: number][] = [['boots', 120], ['hat', 25], ['scarf', 40]]

const plural = (n: number): string => `${n} item${n === 1 ? '' : 's'}`

function AddPanel(c: Process<Cart, Msg>): VNode {
  return div({ class: 'card' },
    span({ class: 'demo-title' }, 'panel one'),
    div({ class: 'row' }, ...STOCK.map(([item, price]) =>
      button({ onclick: () => c.cast({ type: 'add', item, price }) }, `add ${item}`))))
}

function TotalPanel(c: Process<Cart, Msg>): VNode {
  return div({ class: 'card' },
    span({ class: 'demo-title' }, 'panel two'),
    div({ class: 'row' },
      span({ class: 'readout' }, () => `${plural(c().items.length)} · $${c().total}`),
      button({ onclick: () => c.cast({ type: 'clear' }) }, 'clear')),
    ul({ class: 'list' }, () => c().items.map((item, i) => li({ key: i }, item))))
}

export function run(host: Element): Disposable {
  const a = shop.lookup('cart', { userId: 'demo' })
  const b = shop.lookup('cart', { userId: 'demo' })   // same name + args → the same process

  return mount(host, div({ class: 'stack' }, AddPanel(a), TotalPanel(b)))
}
