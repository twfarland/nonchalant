// The pitch demo: a shared cart. Its state moves from this tab to the server
// by changing ONE line — which registry the view looks the cart up in.
// Everything else is identical either way: same process definition, same
// messages, same fine-grained updates, same ask().
//
// Server mode: run `pnpm cart-server` in another terminal, then swap the
// commented line below.

import { define, registry } from '@nonchalant/core'
import type { Process, VNode } from '@nonchalant/core'
import { connect, webSocketTransport } from '@nonchalant/wire'
import { mount } from '@nonchalant/dom'
import { button, div, li, span, ul } from '@nonchalant/dom/tags'
import { cart, type CartMsg, type CartState, type Item, type Shop } from './shared.ts'

// ——— the one line ———
const shop = registry({ cart: define(cart) })                            // state lives in this tab
// const shop = connect<Shop>(webSocketTransport('ws://127.0.0.1:4321/')) // state lives on the server
// ————————————————————
void connect
void webSocketTransport

type Cart = Process<CartState | undefined, CartMsg>

// ---------- components ----------

function AddButton(c: Cart): VNode {
  const something = (): Item => ({ name: `item ${Date.now() % 1000}`, price: 5 })

  return button({ onclick: () => c.send({ type: 'add', item: something() }) }, 'Add something')
}

function CartLines(c: Cart): VNode {
  return ul({}, () =>
    (c()?.items ?? []).map((item) =>
      li({ key: item.name },
        `${item.name} — ${item.price} `,
        button({ onclick: () => c.send({ type: 'remove', name: item.name }) }, '×'))))
}

function Totals(c: Cart): VNode {
  return div({},
    'Total: ',
    span({ class: 'total' }, () => String(c()?.total ?? 0)),
    span({ class: 'muted' }, () => (c.stale ? ' (stale)' : null)))
}

function Checkout(c: Cart): VNode {
  const checkout = (): void => {
    void c.ask({ type: 'checkout' }).then(
      (res) => alert(`charged ${res.charged}`),
      (e) => alert(`checkout failed: ${String(e)}`),
    )
  }

  return button({ onclick: checkout }, 'Checkout')
}

// ---------- the app ----------

function App(): VNode {
  const c = shop.lookup('cart', { userId: 'u1' }) as Cart

  return div({ class: 'cart' },
    AddButton(c),
    CartLines(c),
    Totals(c),
    Checkout(c))
}

mount(document.getElementById('app')!, App())
