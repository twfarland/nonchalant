# Thinking in processes

This tutorial builds a working cart, step by step. By the end, you'll use the
same view with either a local registry or a server-backed one. All the code
here is runnable — most of it comes straight from `examples/`.

## 1. State is a process

In nonchalant, state isn't a store you configure or a hook you call. It's a
**process**. You write one as an async generator — its local variables are the
state, its mailbox is the input, and everything it `yield`s gets published.
`spawn` runs the generator and gives you back a handle to the running
instance; the handle is what you read, send to, and dispose.

```ts
import { spawn } from '@nonchalant/core'
import type { Proc } from '@nonchalant/core'

type CounterMsg = { type: 'add'; n: number }

const counter: Proc<number, CounterMsg, void> = async function* (self) {
  let n = 0                       // this is the state — an ordinary variable
  yield n                         // publish it
  for await (const msg of self) { // wait for messages
    n += msg.n
    yield n                       // publish again
  }
}

const p = spawn(counter, undefined, { initial: 0 })
p()                    // 0 — read the latest value, synchronously
p.send({ type: 'add', n: 5 })
// a moment later: p() === 5
```

There's no `setState` and no reducer boilerplate. `let` works as state because
the generator is suspended between messages, and `yield` is the only ceremony.
The types come along for free: `initial` decides whether reads can be
`undefined`, and the message union decides what `send` accepts.

## 2. Reading doesn't subscribe

In ordinary code, `p()` is just a snapshot:

```ts
if (p() > 10) celebrate()   // reads the value now, remembers nothing
```

Only three places subscribe automatically: `derive`, effects, and view
bindings. Everywhere else, a read is a read. This means a process can freely
look at ten other processes without quietly wiring itself to all of them.

```ts
import { derive } from '@nonchalant/core'
const doubled = derive(() => p() * 2)   // recomputes when p yields
for await (const v of p) { ... }        // an explicit subscription, if you want one
```

## 3. Update immutably, and updates get cheap

Yield new objects that reuse the parts that didn't change — `let` plus spread:

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

Every yield is diffed against the previous one. Because unchanged parts are
the *same objects*, the diff skips them instantly. And the diff is what drives
updates: a binding that read `cart().total` won't wake when `items[3].done`
flips, because no path it read changed. This isn't a vibe — the test suite
asserts exact wake counts, and the Mario demo has a CI budget of at most
3 DOM writes per frame.

The one thing to avoid: mutating your state and yielding a deep clone. It
works, but then nothing is shared and the diff has to look at everything.

## 4. Views run once

A view is a function that returns a tree. Where the tree needs live data, you
put a **binding** — a thunk or a process — and the tree itself never rebuilds:

```ts
import { mount } from '@nonchalant/dom'
import { button, div, li, span, ul } from '@nonchalant/dom/tags'

function CartView(cart: Process<Cart, CartMsg>): VNode {
  return div({},
    ul({}, () => cart().items.map((it) =>
      li({ key: it.name }, it.name))),          // a keyed list — one honest diff
    span({}, () => String(cart().total)),        // wakes only when total changes
    button({ onclick: () => cart.send({ type: 'add', item: pick() }) }, 'Add'))
}

mount(document.getElementById('app')!, CartView(cart))
```

There's no re-render. The function runs once; after that, changes flow through
the bindings to exactly the DOM they affect. Widget-local state is just a
process you close over — see `examples/counter`, where `cell(0)` is five lines
of sugar over `spawn`. When the widget is built inside a view process, its
cells belong to that process and are disposed with it.

## 5. When you need an answer, ask

`send` is fire-and-forget. When the caller needs a reply — a form that wants
to know if its own submit worked — the message is a `Call` and the method is
`ask`. The compiler keeps the two apart: you can't `send` a call or `ask` a
cast.

```ts
type CartMsg =
  | { type: 'add'; item: Item }
  | Call<{ type: 'checkout' }, { ok: boolean; charged: number }>

// inside the generator, a call is just a message with a reply function:
if (msg.type === 'checkout') msg.reply({ ok: true, charged: total })

// outside:
const res = await cart.ask({ type: 'checkout' })   // the reply, typed
```

If a process crashes, its pending asks reject, readers keep the last value
with `stale: true`, and — if you spawned it with `restart: 'on-crash'` — it
restarts from its original arguments with queued messages replayed. See
`examples/form`.

## 6. Share by name

`lookup` means "give me the process with this name — start it if nobody has":

```ts
import { define, registry } from '@nonchalant/core'

const shop = registry({
  cart: define(cartProc),
  user: define(userQuery, { evict: 30_000 }),   // idle 30s after its last watcher → cleaned up
})
const cart = shop.lookup('cart', { userId })
```

That one operation covers a lot of ground. It's dependency injection (any part
of the app can look up the session — no prop drilling). It's a query cache
(same name + args = same process; watchers are counted; idle entries get
evicted, and the next lookup refetches). These lifecycle rules are covered by
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
value with `stale: true`, and reconnecting just re-fetches the state and diffs
it against what you already had — bindings for unchanged data sleep through
the whole thing.

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
decides who may connect. Your process must still enforce which records and
operations that authenticated caller may use. See [Hosting safely](hosting.md).

## Where to next

- [Concepts](concepts.md) — the reference, with pointers to the tests.
- [Recipes](recipes.md) — typeahead, undo/redo, routing, forms, drag.
- [Migration](migration.md) — coming from React, Solid, or LiveView.
- [Hosting safely](hosting.md) — authentication and deployment boundaries.
- [Protocol](PROTOCOL.md) — the wire format, for any language.
