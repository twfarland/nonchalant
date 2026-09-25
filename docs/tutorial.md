# Thinking in processes

This tutorial builds a working cart and then connects the same view to either a
local or server-backed registry. The code is runnable and is drawn largely from
the `examples/` directory.

## 1. State is a process

In Nonchalant, a **process** owns a piece of state. Processes are async
generators: local variables hold state, the mailbox supplies input, and each
`yield` publishes a snapshot. `spawn` runs the generator and returns the handle
used to read it, cast and call, and dispose it.

```ts
import { spawn } from '@nonchalant/core'
import type { Cast, Proc } from '@nonchalant/core'

type CounterMsg = Cast<{ type: 'add'; n: number }>

const counter: Proc<number, CounterMsg, void> = async function* (self) {
  let n = 0                       // local state
  yield n                         // publish it
  for await (const msg of self) { // wait for messages
    n += msg.n
    yield n                       // publish again
  }
}

const p = spawn(counter, undefined, { initial: 0 })
p()                    // read the current value: 0
p.cast({ type: 'add', n: 5 })
// a moment later: p() === 5
```

No store setup or reducer registration is required. The generator preserves
its local variables while suspended between messages, and `yield` publishes
the result. The `initial` option determines whether reads can be `undefined`,
while the message union determines what `cast` accepts.

## 2. Reading doesn't subscribe

Outside a tracked context, `p()` returns a snapshot without subscribing:

<!-- ts-prelude
import type { Cast, Process } from '@nonchalant/core'
declare const p: Process<number, Cast<{ type: 'add'; n: number }>>
declare function celebrate(): void
-->
```ts
if (p() > 10) celebrate()   // reads the value now, remembers nothing
```

Subscriptions are created only where you ask for them. `derive` computes a
value from other processes and recomputes when what it read changes. `effect`
runs a side effect now and again whenever what it read changes, and returns a
function that stops it. Iterating a process with `for await` is an explicit
subscription too. Reads anywhere else do not create dependencies, so a process
can inspect other processes without subscribing to them.

<!-- ts-prelude
import type { Cast, Process } from '@nonchalant/core'
declare const p: Process<number, Cast<{ type: 'add'; n: number }>>
-->
```ts
import { derive, effect } from '@nonchalant/core'

const doubled = derive(() => p() * 2)                       // recomputes when p yields
const stop = effect(() => { document.title = `${p()}` })    // re-runs when p yields
for await (const v of p) console.log(v, doubled())          // an explicit subscription
stop()
```

## 3. Use immutable updates

Yield new objects while reusing values that have not changed:

```ts
import type { Cast, Proc } from '@nonchalant/core'

type Item = { id: number; name: string; price: number }
type Cart = { items: Item[]; total: number }
type CartMsg = Cast<{ type: 'add'; item: Item }>

const cartProc: Proc<Cart, CartMsg, void> = async function* (self) {
  let s: Cart = { items: [], total: 0 }
  yield s
  for await (const msg of self) {
    switch (msg.type) {
      case 'add':
        s = { ...s, items: [...s.items, msg.item], total: s.total + msg.item.price }
        break
    }
    yield s
  }
}
```

Each yield is compared with the previous snapshot. When unchanged branches keep
the same object identity, the comparison can skip them. The resulting patch
drives updates, so renaming one item does not notify a binding that only read
`cart().total`.

The one thing to avoid: mutating your state and yielding a deep clone. It
works, but then nothing is shared and the diff has to look at everything.

## 4. Why structural sharing matters

In the repository benchmark, changing one field in 10,000 items takes about
50 µs to diff. Unchanged objects keep the same references, allowing the diff to
skip them in constant time. Tracked reads separate a dependency on `total` from
one on `items`, and patches notify only readers of affected paths. The test suite
checks notification counts, while the Mario demo is limited to one view yield
and three DOM writes per frame.

## 5. Views run once

A view is a function that returns a tree. Add a **binding**, either a thunk or a
process, wherever the tree needs live data. The surrounding tree is created
once:

<!-- ts-prelude
import type { Cast, Proc } from '@nonchalant/core'
type Item = { id: number; name: string; price: number }
type Cart = { items: Item[]; total: number }
type CartMsg = Cast<{ type: 'add'; item: Item }>
declare const cartProc: Proc<Cart, CartMsg, void>
-->
```ts
import { spawn } from '@nonchalant/core'
import type { Process, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, li, span, ul } from '@nonchalant/dom/tags'

const menu = [{ name: 'tea', price: 3 }, { name: 'cake', price: 5 }]
let nextId = 0
const pick = (): Item => {
  const id = nextId++
  return { id, ...menu[id % menu.length]! }
}

function CartView(cart: Process<Cart, CartMsg>): VNode {
  return div({},
    ul({}, () => cart().items.map((it) =>
      li({ key: it.id }, it.name))),             // a keyed list
    span({}, () => String(cart().total)),        // wakes only when total changes
    button({ onclick: () => cart.cast({ type: 'add', item: pick() }) }, 'Add'))
}

const cart = spawn(cartProc, undefined, { initial: { items: [], total: 0 } })
mount(document.getElementById('app')!, CartView(cart))
```

The function runs once. Later changes pass through bindings to the DOM nodes
they affect. A widget can close over its own process, as `examples/counter`
does with `cell(0)`, a small wrapper around `spawn`. Cells created inside a view
process belong to it and are disposed when it ends.

## 6. When you need an answer, call

`cast` does not wait for a response. When a caller needs the result, such as a
form checking whether its submission succeeded, use a `Call` with `call`.
TypeScript prevents a `Call` from being cast and a `Cast` from being called.

<!-- ts-prelude
import type { Call, Cast, Process } from '@nonchalant/core'
type Item = { id: number; name: string; price: number }
type Cart = { items: Item[]; total: number }
declare let s: Cart
declare const msg: CartMsg
declare const cart: Process<Cart, CartMsg>
-->
```ts
type CartMsg =
  | Cast<{ type: 'add'; item: Item }>
  | Call<{ type: 'checkout' }, { ok: boolean; charged: number }>

// inside the generator, one case per message; a call carries a reply function:
switch (msg.type) {
  case 'add':
    s = { ...s, items: [...s.items, msg.item], total: s.total + msg.item.price }
    break
  case 'checkout':
    msg.reply({ ok: true, charged: s.total })
    s = { items: [], total: 0 }
    break
}

// outside:
const res = await cart.call({ type: 'checkout' })   // the reply, typed
```

If a process crashes, pending calls reject and readers retain the last value
with `stale: true`. With `restart: 'on-crash'`, it restarts from its original
arguments and replays queued messages. See `examples/form`, and
[Error handling](errors.md) for every way a call can reject.

## 7. Share by name

`lookup` returns the process for a name and arguments, starting it when needed:

<!-- ts-prelude
import type { Proc } from '@nonchalant/core'
type Cart = { items: { id: number; name: string; price: number }[]; total: number }
declare const cartProc: Proc<Cart, never, void>
declare const userQuery: Proc<{ name: string }, never, { userId: string }>
declare const userId: string
-->
```ts
import { define, registry } from '@nonchalant/core'

const shop = registry({
  cart: define(cartProc),
  user: define(userQuery, { evict: 30_000 }),   // idle 30s after its last watcher → cleaned up
})
const cart = shop.lookup('cart')
const user = shop.lookup('user', { userId })
```

This provides shared dependencies without prop drilling and caches process
instances by name and arguments. The registry counts watchers, evicts idle
entries, and starts a fresh process on the next lookup. These lifecycle rules are covered by
`packages/core/test/registry.test.ts`.

## 8. Use a remote registry

`connect(transport)` returns the same lookup interface, backed by a server.
The shared-cart example makes the boundary visible:

<!-- ts-prelude
import { define, registry } from '@nonchalant/core'
import type { Proc } from '@nonchalant/core'
declare const cartProc: Proc<{ total: number }, never, void>
-->
```ts
const shop = registry({ cart: define(cartProc) })                    // in this tab
// const shop = connect<Shop>(webSocketTransport('ws://…:4321/'))    // on the server
```

The cart and view code do not change because they depend on the registry
interface rather than a concrete location.
Updates cross the wire as small patches (the same format used locally), remote
reads stay fine-grained, losing the connection leaves readers on the last
value with `stale: true`. After reconnecting, the client retrieves the state
again and compares it with the retained value. Bindings for unchanged data are
not notified.

The server setup is small (`examples/shared-cart/server.ts`):

<!-- ts-prelude
import type { IncomingMessage } from 'node:http'
import type { Proc } from '@nonchalant/core'
declare const cartProc: Proc<{ total: number }, never, void>
declare function sessionFromRequest(request: IncomingMessage): Promise<{ user: string } | undefined>
-->
```ts
import { define } from '@nonchalant/core'
import { serve } from '@nonchalant/host'

const host = await serve({ cart: define(cartProc) }, {
  port: 4321,
  allowedOrigins: ['https://shop.example'],
  authorize: async (request) => Boolean(await sessionFromRequest(request)),
})
```

The open default is convenient for the local example, not a production
security policy. Origin checks protect browser handshakes; authorization
decides who may connect; the `scope` option decides which processes each
connection's lookups may reach. The gateway `scope` returns can also `admit`
or refuse each message a client sends, and name a `principal` so one client's
call ids cannot collide with another's; lookups are rate-limited per
connection. Alternatively, processes can enforce record and operation access
themselves. See [Hosting safely](hosting.md).

## Where to next

- [Concepts](concepts.md): reference material with links to tests.
- [API reference](api.md): every export, with its signature.
- [Error handling](errors.md): what fails, how it surfaces, and what to do.
- [Recipes](recipes.md): typeahead, undo/redo, routing, forms, and drag.
- [Migration](migration.md): guidance for React, Solid, and LiveView users.
- [Hosting safely](hosting.md): authentication and deployment boundaries.
- [Protocol](PROTOCOL.md): the language-independent wire format.
