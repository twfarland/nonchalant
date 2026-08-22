# Thinking in processes

The tutorial. You will build a working cart, learn the one primitive by using
it, and end by moving your state to a server without touching the view.
Everything here is runnable code from `examples/`.

## 1. A process is an async generator

State in nonchalant is not a store, a hook, or a signal graph you assemble.
It is a **process**: an async generator whose local `let` variables are the
state, whose mailbox is the input, and whose `yield`s are the published values.

```ts
import { spawn } from '@nonchalant/core'
import type { Proc, Self } from '@nonchalant/core'

type CounterMsg = { type: 'add'; n: number }

const counter: Proc<number, CounterMsg, void> = async function* (self) {
  let n = 0                       // this IS the state — a plain local
  yield n                         // publish
  for await (const msg of self) { // the mailbox — FIFO, backpressured
    n += msg.n
    yield n                       // every yield is published
  }
}

const p = spawn(counter, undefined, { initial: 0 })
p()                // 0 — synchronous read of the latest yield
p.send({ type: 'add', n: 5 })
// …a tick later: p() === 5
```

There is no `setState`, no reducer registry, no reactivity annotation. `let`
is real state because the generator frame is suspended, and `yield` is the
only ceremony. The compiler knows `p` from `spawn`'s types: `initial` decides
whether reads can be `undefined`; the message union decides whether `send`
and `ask` exist and what they accept.

## 2. Reads are pulls; subscription is explicit

Inside ordinary code, `p()` is a snapshot — no subscription happens:

```ts
if (p() > 10) confetti()   // reads now, forgets immediately
```

Only three contexts auto-track: `derive`, effects, and view bindings. This is
the rule that lets a process close over ten other processes without accreting
a dependency web (docs/DESIGN.md "pull vs subscribe").

```ts
import { derive } from '@nonchalant/core'
const doubled = derive(() => p() * 2)   // memoised; recomputes when p yields
for await (const v of p) { ... }        // lossy latest-value stream, explicit
```

## 3. Write plain, read tracked

Yield **immutable updates** — `let` + spread:

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

Every yield is diffed against the previous one (`reconcile` — identity checks
make shared structure free), and only readers whose recorded paths intersect
the patch wake. A binding that read `cart().total` sleeps through a change to
`items[3].done`. This is measured behavior, not aspiration: the test suite
asserts exact wake counts, and Mario ships with a CI budget of ≤ 3 DOM writes
per frame.

The anti-pattern is mutating and yielding a clone: it works, but every yield
then shares no structure and the diff walks everything. The dev guidance is
simple — spread what changed, reuse the rest.

## 4. Views are processes that yield once

A view yields a **tree of bindings**. Holes — thunks and processes placed in
the tree — carry all value changes; the generator only resumes for structural
change (a route swap). Re-yielding per value is a performance bug.

```ts
import { mount } from '@nonchalant/dom'
import { button, div, li, span, ul } from '@nonchalant/dom/tags'

function CartView(cart: Process<Cart, CartMsg>): VNode {
  return div({},
    ul({}, () => cart().items.map((it) =>
      li({ key: it.name }, it.name))),          // one honest keyed diff
    span({}, () => String(cart().total)),        // a binding: wakes on /total only
    button({ onclick: () => cart.send({ type: 'add', item: pick() }) }, 'Add'))
}

mount(document.getElementById('app')!, CartView(cart))
```

Component-local state is a closed-over process — see `examples/counter`:
`cell(0)` is five lines of userland sugar over `spawn`, owned by the enclosing
scope, dead when the widget goes.

## 5. Ask when you need an answer

`send` is a cast — fire and forget. When the caller needs a reply, the message
is a `Call` and the method is `ask`; the compiler refuses to `send` a call or
`ask` a cast:

```ts
type CartMsg =
  | { type: 'add'; item: Item }
  | Call<{ type: 'checkout' }, { ok: boolean; charged: number }>

// inside the generator, a call is an ordinary message carrying reply:
if (msg.type === 'checkout') msg.reply({ ok: true, charged: total })

// outside:
const res = await cart.ask({ type: 'checkout' })   // typed reply
```

Crashed processes reject their pending asks; readers keep the last value with
`stale: true`; `restart: 'on-crash'` re-runs the generator from its init args
with queued casts replayed. See `examples/form` and the M3 tests.

## 6. Share by name: the registry

`lookup` is get-or-spawn. The same operation is dependency injection, query
caching, and — next section — remote addressing:

```ts
import { define, registry } from '@nonchalant/core'

const shop = registry({
  cart: define(cartProc),
  user: define(userQuery, { evict: 30_000 }),   // SWR: idle 30s after last watcher → evicted
})
const cart = shop.lookup('cart', { userId })     // first caller spawns; the rest share
```

Watchers are subscriptions (bindings, derives, iterations) — snapshot pulls
don't count. The query cache from TanStack is twenty lines of this; the test
at `packages/core/test/registry.test.ts` is the recipe.

## 7. The one line

`connect(transport)` returns the same `Registry` interface. The pitch demo
(`examples/shared-cart`) is a cart whose state moves from the tab to a server
by changing which registry the view looks it up in:

```ts
const shop = registry({ cart: define(cart) })                        // local
// const shop = connect<Shop>(webSocketTransport('ws://…:4321/'))    // shared
```

The process does not know which side of the wire it runs on. Yields cross as
patches (the same codec as local updates), remote reads stay path-precise,
a partition leaves readers on the last value with `stale: true`, and reconnect
is just a re-lookup answered with a full snapshot — diffed against what you
already have, so unchanged bindings sleep through it.

The server (`examples/shared-cart/server.ts`) is three lines:

```ts
import { serve } from '@nonchalant/host'
const host = await serve({ cart: define(cart) }, { port: 4321 })
```

## Where next

- `docs/concepts.md` — the reference: every concept, its contract, its tests.
- `docs/recipes.md` — typeahead, undo/redo, routing, forms, drag, middleware.
- `docs/migration.md` — coming from React, Solid, or LiveView.
- `docs/PROTOCOL.md` — the wire, for non-JS hosts.
