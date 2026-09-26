# Nonchalant

> [!WARNING]
> **Experimental alpha software.** This is a research project, not a product.
> Nothing is published to npm, there is no versioning policy, and the API, the
> wire protocol, and the package names may all change without notice or a
> migration path. Read it, run the demos, take the ideas — but do not put it in
> production.

Write application state as async generators. The page updates only where the
state changed, and the same process runs in a worker, another tab, or on your
server.

**[Read the site](https://twfarland.github.io/nonchalant/)**: an overview, a
guide, live demos, the documentation, and the example gallery.

## Why it exists

A typical web app manages its state with several different tools: hooks or
signals for component state, a store for shared state, a query cache for server
data, a socket layer to keep live data in sync, and a workflow engine for
long-running backend jobs. Each has its own API, lifecycle, and failure modes,
and moving state from one to another means rewriting it. The same bugs recur in
all of them: clicks racing each other, stale closures, missing dependencies,
responses that land after the user has moved on, and re-renders caused by
changes a component doesn't display.

Nonchalant tries one primitive for all of it, and it is one JavaScript already
has. An async generator keeps state in local variables, takes input in order
with `for await`, publishes with `yield`, and cleans up in `finally`.
Nonchalant runs it as a **process**: `spawn` returns a typed handle for reading
its state, sending it messages, and disposing it.

```ts
import { spawn } from '@nonchalant/core'
import type { Self } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, span } from '@nonchalant/dom/tags'

const counter = spawn(async function* (self: Self<number>) {
  let n = 0                          // the state: an ordinary variable
  yield n                            // publish it
  for await (const d of self) {      // take each message, in order
    n += d
    yield n                          // publish the new state
  }
}, undefined, { initial: 0 })

mount(document.getElementById('app')!, div({},
  button({ onclick: () => counter.cast(-1) }, '−'),
  span({}, counter),                 // a binding: updates itself, nothing else re-runs
  button({ onclick: () => counter.cast(1) }, '+')))
```

The view runs once. A process or a function placed in the tree is a binding
that updates only its own spot on the page when the state it read changes. The
same process can be shared by name through a registry, moved to a worker or a
server by changing one line, or made durable so it survives a restart. It is not
a React component model, an Erlang runtime, or a full query client.

## What it offers

- **Views execute once.** A view returns a tree containing live bindings.
  Updates do not call the view again, so there is no need to stabilize callbacks
  or maintain dependency arrays. Structure changes through keyed lists and
  replaceable regions: a binding that returns a subtree, which the renderer
  patches or swaps in place without touching the rest of the tree.

- **Updates are limited to affected readers.** Write standard immutable updates
  and yield the next snapshot. Nonchalant compares it with the previous value
  and notifies readers only when a path they used has changed. CI verifies that
  changing one label in a 50-row list performs one DOM write. It also limits the
  60 fps game demo to one view yield and at most two DOM writes in its busiest
  frame.

```ts nocheck
s = { ...s, total: s.total + item.price }   // update immutably
yield s                                     // diffed → only /total readers wake;
                                            // a binding on items[3].done sleeps through it
```

- **The mailbox handles messages sequentially.** Repeated submissions queue
  instead of racing. `latest()` discards older queued input when only the newest
  value matters, and the abort signal cancels work when the process ends.

```ts nocheck
for await (const { q } of self.latest()) {          // queued keystrokes conflate to the newest
  results = await api.search(q, { signal: self.signal })
  yield { q, results }
}
```

- **Requests and responses are typed.** A one-way message is a `Cast`; one that
  expects a response is a `Call`. `call()` returns a promise for that response
  and rejects if the process crashes. TypeScript prevents a `Call` from being
  passed to `cast` and a `Cast` from being passed to `call`.

<!-- ts-prelude
import type { Call, Cast, Process } from '@nonchalant/core'
type Item = { name: string; price: number }
type Cart = { items: Item[]; total: number }
declare const cart: Process<Cart, CartMsg>
-->
```ts
type CartMsg =
  | Cast<{ type: 'add'; item: Item }>                             // a cast
  | Call<{ type: 'checkout' }, { ok: boolean; charged: number }>  // a call

const res = await cart.call({ type: 'checkout' })   // res is typed; crash = rejection
```

- **One lookup interface works locally and remotely.** `lookup(name, args)` can
  provide a shared dependency, reuse a cached process by name and arguments, or
  address a remote process. `connect(transport)` changes where the lookup goes
  without changing its interface. Remote use still requires JSON-compatible
  values, network failure handling, and authentication on deployed hosts.

<!-- ts-prelude
import { define, registry } from '@nonchalant/core'
import type { Proc } from '@nonchalant/core'
declare const cart: Proc<{ total: number }, never, void>
-->
```ts
const shop = registry({ cart: define(cart) })                       // this tab
// const shop = connect<Shop>(portTransport(new Worker(url)))       // another thread
// const shop = connect<Shop>(broadcastChannelTransport('shop'))    // another tab
// const shop = connect<Shop>(webSocketTransport('wss://…'))        // another machine
```

- **Processes can be tested directly.** `Self` is an interface implemented by
  `channel()`, so tests can drive the generator without starting the runtime,
  installing fake timers, or creating a DOM ([docs/testing.md](docs/testing.md)).

<!-- ts-prelude
import { channel } from '@nonchalant/core'
import type { Cast, Proc } from '@nonchalant/core'
import { expect } from 'vitest'
type Msg = Cast<{ type: 'add'; title: string }>
declare const todosProc: Proc<{ todos: { title: string }[] }, Msg, void>
-->
```ts
const self = channel<Msg>()                  // a scripted mailbox
self.cast({ type: 'add', title: 'milk' })
const it = todosProc(self, undefined)
expect((await it.next()).value).toMatchObject({ todos: [{ title: 'milk' }] })
```

- **Sugar is optional and compiles to the primitive.** `cell` covers widget
  state, and `reducer` writes the common
  loop-switch-yield process as a function of state and message. Both produce
  an ordinary process, so the registry, the wire, `durable`, and the inspector
  treat them the same as a hand-written generator, and a reducer that later
  needs to await can be rewritten as one without its callers changing
  ([the layers](docs/concepts.md#layers-the-primitive-and-its-sugar)).

<!-- ts-prelude
import { reducer } from '@nonchalant/core'
import type { Cast } from '@nonchalant/core'
type Msg = Cast<{ type: 'add'; by: number }>
-->
```ts
function count(n: number, msg: Msg): number {
  switch (msg.type) {
    case 'add':
      return n + msg.by
  }
}
const counter = reducer(() => 0, count)  // a Proc, like any async generator
```

- **The wire protocol is language-independent.** Eight JSON operations carry
  state patches rather than markup or code. Other languages can implement a
  host against the conformance vectors in `packages/wire/spec/`.
- **One library where you would otherwise assemble a stack.** Local and shared
  state, rendering, a query cache, worker, tab, and server sync, durable
  workflows, and an inspector all come from the same process model, instead
  of separate libraries with separate lifecycles. Size is reported rather than
  capped: `pnpm size` prints what each entry point costs.
- **Text is never parsed as HTML.** The DOM renderer creates elements and text
  nodes directly and sets attributes with `setAttribute`, so markup in
  application data stays inert text. That closes markup injection; it does not
  vet URLs, so a user-supplied `href` still deserves validation.

## Not yet

- **No server-side rendering or hydration.** The DOM renderer builds every
  node in the browser. A server runs processes and sends state, not HTML.
- **Not published to npm.** The packages build and pack (`pnpm verify:pack`),
  but the scope is unclaimed; use the repository directly for now.

## Compared to what you know

| | you write | state lives in | updates happen by | state addressable over the wire |
|---|---|---|---|---|
| **React** | functions, re-run every update | hooks | re-render + vdom diff | no |
| **Solid** | functions, run once | signals / stores | fine-grained graph | no |
| **Svelte 5** | compiled components | `$state` runes | compiler-injected updates | no |
| **Crank** | generator components + JSX | plain locals | re-render + vdom diff | no |
| **LiveView** | server templates | server assigns | HTML diffs over the wire | server-only |
| **nonchalant** | generator processes | plain `let` locals | yield → diff → wake by path | local or remote registry lookup |

These libraries make different tradeoffs. The [migration guide](docs/migration.md)
describes Nonchalant's costs, including the lack of built-in JSX ergonomics,
explicit thunks for reactive expressions, and no BEAM-style preemption.

## Try it

```sh
pnpm install
pnpm dev         # the doc site at /, the example gallery at /examples/
pnpm test        # the whole suite, including the perf and granularity budgets
pnpm size        # what each entry point costs, min+gzip
pnpm check       # strict TypeScript across packages, examples, the site, and doc samples
pnpm build:site  # the static site, as GitHub Pages publishes it
```

## Learn it

| doc | what it is |
|---|---|
| [Thinking in processes](docs/tutorial.md) | build a cart locally, then move it to a server |
| [Concepts](docs/concepts.md) | the reference: each concept, its contract, its tests |
| [API reference](docs/api.md) | every export of every package, with its signature |
| [Error handling](docs/errors.md) | crashes, stale values, call rejections, render and wire failures |
| [Recipes](docs/recipes.md) | typeahead, forms, query cache, routing, undo/redo, drag, durability |
| [Testing](docs/testing.md) | driving generators directly, transcripts, views as data |
| [Migration](docs/migration.md) | coming from React, Solid, or LiveView |
| [Processes on the server](docs/server.md) | virtual actors, durable execution, agent loops, and current limits |
| [Hosting safely](docs/hosting.md) | authentication, browser origins, and deployment boundaries |
| [Protocol](docs/PROTOCOL.md) | the data wire and conformance rules |
| [Examples](examples/README.md) | the demo ladder |
| [Internals](docs/internals/README.md) | contributor notes: how core is built, and its invariants |
| [Contributing](CONTRIBUTING.md) | commands, budgets, house style; [security reports](SECURITY.md) |

## Packages

| package | contents |
|---|---|
| `@nonchalant/core` | `Process`, `spawn`, `derive`, the registry, `reconcile`, the reactive graph, and the optional `cell` and `reducer` sugar. Zero dependencies, no DOM. |
| `@nonchalant/dom` | tag constructors, `h()`, the DOM sink, keyed reconciliation, `mount`. |
| `@nonchalant/wire` | the protocol, codec, transports (WebSocket, worker port, BroadcastChannel, in-memory), `connect`. Isomorphic. |
| `@nonchalant/durable` | `durable(proc)`: the message journal, the effect journal, durable calls, and the `Store` port. Isomorphic; ships the in-memory adapter. |
| `@nonchalant/host` | the Node WebSocket host: handshake authorization, origin policy, per-connection registry scoping, and connection limits. |

## Credits and prior art

- The push-pull propagation core is ported from
  [alien-signals](https://github.com/stackblitz/alien-signals) by Johnson Chu
  (MIT). Nonchalant adds path-aware updates without changing the ported layer.
- [Crank.js](https://crank.js.org) demonstrated how generator components can
  manage local state. Nonchalant combines that approach with live bindings, a
  mailbox, and a wire protocol instead of virtual DOM rerenders.
- **Erlang/OTP** informed mailboxes, casts and calls,
  restart-from-init-args, ownership, and named processes. Nonchalant does not
  provide process isolation, preemption, escalation, or OTP supervision trees.
- **The Elm architecture** informed the model/update/view pattern that several
  examples follow.
- **Solid** and **lit-html** informed the localized keyed diff.
- **Phoenix LiveView** informed the server-held UI state; Nonchalant's wire
  carries data patches instead of HTML.
- **TanStack Query** informed cache keys, sharing, watcher counts, and
  idle eviction. The registry implements those lifecycle pieces, not the full
  product surface of a query client.
- [7GUIs](https://eugenkiss.github.io/7guis/) (Eugen Kiss), **TodoMVC**, and
  the [krausest js-framework-benchmark](https://github.com/krausest/js-framework-benchmark)
  are the basis for example and benchmark implementations in `examples/`.

MIT © Tim Farland
