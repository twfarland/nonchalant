# Thinking in processes

This tutorial builds a working cart and then connects the same view to either a
local or server-backed registry. The code is runnable and is drawn largely from
the `examples/` directory.

## 1. State is a process

In Nonchalant, a **process** owns a piece of state. Processes are async
generators: local variables hold state, the mailbox supplies input, and each
`yield` publishes a snapshot. `spawn` runs the generator and returns the handle
used to read it, send messages, and dispose it.

```ts
import { spawn } from '@nonchalant/core'
import type { Proc } from '@nonchalant/core'

type CounterMsg = { type: 'add'; n: number }

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
p.send({ type: 'add', n: 5 })
// a moment later: p() === 5
```

No store setup or reducer registration is required. The generator preserves
its local variables while suspended between messages, and `yield` publishes
the result. The `initial` option determines whether reads can be `undefined`,
while the message union determines what `send` accepts.

## 2. Reading doesn't subscribe

Outside a tracked context, `p()` returns a snapshot without subscribing:

```ts
if (p() > 10) celebrate()   // reads the value now, remembers nothing
```

Automatic subscriptions are created only inside `derive`, effects, and view
bindings. Reads elsewhere do not create dependencies, so a process can inspect
other processes without subscribing to them.

```ts
import { derive } from '@nonchalant/core'
const doubled = derive(() => p() * 2)   // recomputes when p yields
for await (const v of p) { ... }        // an explicit subscription, if you want one
```

## 3. Use immutable updates

Yield new objects while reusing values that have not changed:

```ts
type Cart = { items: Item[]; total: number }

const cart: Proc<Cart, CartMsg, void> = async function* (self) {
  let s: Cart = { items: [], total: 0 }
  yield s
  for await (const msg of self) {
    if (msg.type === 'add') s = { ...s, items: [...s.items, msg.item] }
    yield s
  }
}
```

Each yield is compared with the previous snapshot. When unchanged branches keep
the same object identity, the comparison can skip them. The resulting patch
drives updates, so changing `items[3].done` does not notify a binding that only
read `cart().total`. Tests verify exact notification counts, and the Mario demo
has a CI limit of three DOM writes per frame.

The one thing to avoid: mutating your state and yielding a deep clone. It
works, but then nothing is shared and the diff has to look at everything.

## 3.5. Why structural sharing matters

In the repository benchmark, changing one field in 10,000 items takes about
50 µs to diff. Unchanged objects keep the same references, allowing the diff to
skip them in constant time. Tracked reads separate a dependency on `total` from
one on `items`, and patches notify only readers of affected paths. The test suite
checks notification counts, while the Mario demo is limited to one view yield
and three DOM writes per frame.

## 4. Views run once

A view is a function that returns a tree. Add a **binding**, either a thunk or a
process, wherever the tree needs live data. The surrounding tree is created
once:

```ts
import { mount } from '@nonchalant/dom'
import { button, div, li, span, ul } from '@nonchalant/dom/tags'

function CartView(cart: Process<Cart, CartMsg>): VNode {
  return div({},
    ul({}, () => cart().items.map((it) =>
      li({ key: it.name }, it.name))),          // a keyed list
    span({}, () => String(cart().total)),        // wakes only when total changes
    button({ onclick: () => cart.send({ type: 'add', item: pick() }) }, 'Add'))
}

mount(document.getElementById('app')!, CartView(cart))
```

The function runs once. Later changes pass through bindings to the DOM nodes
they affect. A widget can close over its own process, as `examples/counter`
does with `cell(0)`, a small wrapper around `spawn`. Cells created inside a view
process belong to it and are disposed when it ends.

## 5. When you need an answer, ask

`send` does not wait for a response. When a caller needs the result, such as a
form checking whether its submission succeeded, use a `Call` with `ask`.
TypeScript prevents calls from being sent as casts and casts from being asked.

```ts
type CartMsg =
  | { type: 'add'; item: Item }
  | Call<{ type: 'checkout' }, { ok: boolean; charged: number }>

// inside the generator, a call carries a reply function:
if (msg.type === 'checkout') msg.reply({ ok: true, charged: total })

// outside:
const res = await cart.ask({ type: 'checkout' })   // the reply, typed
```

If a process crashes, pending asks reject and readers retain the last value
with `stale: true`. With `restart: 'on-crash'`, it restarts from its original
arguments and replays queued messages. See
`examples/form`.

## 6. Share by name

`lookup` returns the process for a name and arguments, starting it when needed:

```ts
import { define, registry } from '@nonchalant/core'

const shop = registry({
  cart: define(cartProc),
  user: define(userQuery, { evict: 30_000 }),   // idle 30s after its last watcher → cleaned up
})
const cart = shop.lookup('cart', { userId })
```

This provides shared dependencies without prop drilling and caches process
instances by name and arguments. The registry counts watchers, evicts idle
entries, and starts a fresh process on the next lookup. These lifecycle rules are covered by
`packages/core/test/registry.test.ts`.

## 7. Use a remote registry

`connect(transport)` returns the same lookup interface, backed by a server.
The shared-cart example makes the boundary visible:

```ts
const shop = registry({ cart: define(cart) })                        // in this tab
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

```ts
import { serve } from '@nonchalant/host'
const host = await serve({ cart: define(cart) }, {
  port: 4321,
  allowedOrigins: ['https://shop.example'],
  authorize: async (request) => Boolean(await sessionFromRequest(request)),
})
```

The open default is convenient for the local example, not a production
security policy. Origin checks protect browser handshakes; authorization
decides who may connect; the `scope` option decides which processes each
connection's lookups may reach. Alternatively, processes can enforce record and
operation access themselves. See [Hosting safely](hosting.md).

## Where to next

- [Concepts](concepts.md): reference material with links to tests.
- [Recipes](recipes.md): typeahead, undo/redo, routing, forms, and drag.
- [Migration](migration.md): guidance for React, Solid, and LiveView users.
- [Hosting safely](hosting.md): authentication and deployment boundaries.
- [Protocol](PROTOCOL.md): the language-independent wire format.
