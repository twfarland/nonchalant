// The pitch demo: shared cart. State moves from this tab to the server by
// changing ONE line — the registry the view looks the cart up in. Everything
// below the fold is identical either way: same process definition, same
// messages, same path-precise granularity, same ask().

import { define, registry } from '@nonchalant/core'
import type { Process, VNode } from '@nonchalant/core'
import { connect, webSocketTransport } from '@nonchalant/wire'
import { mount } from '@nonchalant/dom'
import { button, div, li, span, ul } from '@nonchalant/dom/tags'
import { cart, type CartMsg, type CartState, type Shop } from './shared.ts'

// ——— the one line ———
const shop = registry({ cart: define(cart) })                       // state lives in this tab
// const shop = connect<Shop>(webSocketTransport('ws://127.0.0.1:4321/')) // state lives on the server
// ————————————————————
void connect
void webSocketTransport

function App(): VNode {
  const c = shop.lookup('cart', { userId: 'u1' }) as Process<CartState | undefined, CartMsg>
  return div({ class: 'cart' },
    button({ onclick: () => c.send({ type: 'add', item: { name: `item ${Date.now() % 1000}`, price: 5 } }) },
      'Add something'),
    ul({}, () => (c()?.items ?? []).map((it) =>
      li({ key: it.name },
        `${it.name} — ${it.price} `,
        button({ onclick: () => c.send({ type: 'remove', name: it.name }) }, '×')))),
    div({},
      'Total: ',
      span({ class: 'total' }, () => String(c()?.total ?? 0)),
      span({}, () => (c.stale ? ' (stale)' : null))),
    button({
      onclick: () => {
        void c.ask({ type: 'checkout' }).then(
          (res) => alert(`charged ${res.charged}`),
          (e) => alert(`checkout failed: ${String(e)}`),
        )
      },
    }, 'Checkout'))
}

mount(document.getElementById('app')!, App())
