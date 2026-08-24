# Nonchalant

Nonchalant is an experimental TypeScript runtime for managing state with async
generators. Optional packages add DOM rendering and remote connections. Each
process owns its state, handles messages in order, publishes snapshots, and has
a defined lifetime. Calling `spawn` returns a typed handle for reading state,
sending messages, making requests, iterating over values, and disposing the
process.

The project asks whether one process model can cover widget state, shared
application state, cached work, remote state, agent loops, and durable
workflows. It is not a React component model, an Erlang runtime, or a full query
client. Its focus is narrower: ordered message handling, targeted snapshot
updates, process ownership, and a compact protocol that carries data.

Visit **[twfarland.github.io/nonchalant](https://twfarland.github.io/nonchalant/)**
for an overview, live demos, and the full example gallery.

```ts
import { spawn } from '@nonchalant/core'
import type { Self } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, span } from '@nonchalant/dom/tags'

const counter = spawn(async function* (self: Self<number>) {
  let n = 0                          // this is the state
  yield n
  for await (const d of self) {      // this is the input
    n += d
    yield n                          // this is the output
  }
}, undefined, { initial: 0 })

mount(document.getElementById('app')!, div({},
  button({ onclick: () => counter.send(-1) }, '−'),
  span({}, counter),                 // a live binding
  button({ onclick: () => counter.send(1) }, '+')))
```

## Why use processes?

Async generators already provide the main parts of a state process: local `let`
variables, sequential input through `for await`, and a lifetime that ends with
`return` or `dispose`. The same interface can represent a local cell, a cached
query, or a process on a server. `registry.lookup` handles shared dependencies,
cached process instances, and remote addresses. Views execute once, and later
state changes notify bindings according to the paths they read.

## What it offers

- **Views execute once.** A view returns a tree containing live bindings.
  Updates do not call the view again, so there is no need to stabilize callbacks
  or maintain dependency arrays. Keyed lists and replaceable regions handle
  changes to structure.

- **Updates are limited to affected readers.** Write standard immutable updates
  and yield the next snapshot. Nonchalant compares it with the previous value
  and notifies readers only when a path they used has changed. CI verifies that
  changing one label in a 50-row list performs one DOM write. It also limits the
  60 fps game demo to one view yield and three DOM writes per frame.

```ts
s = { ...s, total: s.total + item.price }   // update immutably
yield s                                     // diffed → only /total readers wake;
                                            // a binding on items[3].done sleeps through it
```

- **The mailbox handles messages sequentially.** Repeated submissions queue
  instead of racing. `latest()` discards older queued input when only the newest
  value matters, and the abort signal cancels work when the process ends.

```ts
for await (const { q } of self.latest()) {          // queued keystrokes conflate to the newest
  results = await api.search(q, { signal: self.signal })
  yield { q, results }
}
```

- **Requests and responses are typed.** A message that expects a response is a
  `Call`. `ask()` returns a promise for that response and rejects if the process
  crashes. TypeScript prevents calls from being passed to `send` and casts from
  being passed to `ask`.

```ts
type CartMsg =
  | { type: 'add'; item: Item }                                   // a cast
  | Call<{ type: 'checkout' }, { ok: boolean; charged: number }>  // a call

const res = await cart.ask({ type: 'checkout' })   // res is typed; crash = rejection
```

- **One lookup interface works locally and remotely.** `lookup(name, args)` can
  provide a shared dependency, reuse a cached process by name and arguments, or
  address a remote process. `connect(transport)` changes where the lookup goes
  without changing its interface. Remote use still requires JSON-compatible
  values, network failure handling, and authentication on deployed hosts.

```ts
const shop = registry({ cart: define(cart) })                       // this tab
// const shop = connect<Shop>(portTransport(new Worker(url)))       // another thread
// const shop = connect<Shop>(broadcastChannelTransport('shop'))    // another tab
// const shop = connect<Shop>(webSocketTransport('wss://…'))        // another machine
```

- **Processes can be tested directly.** `Self` is an interface implemented by
  `channel()`, so tests can drive the generator without starting the runtime,
  installing fake timers, or creating a DOM ([docs/testing.md](docs/testing.md)).

```ts
const self = channel<Msg>()                  // a scripted mailbox
self.send({ type: 'add', title: 'milk' })
const it = todosProc(self, undefined)
expect((await it.next()).value.todos).toHaveLength(1)
```

- **The wire protocol is language-independent.** Eight JSON operations carry
  state patches rather than markup or code. Other languages can implement a
  host against the conformance vectors in `packages/wire/spec/`.
- **Small, with enforced limits.** CI keeps core at or below 8 KB gzipped and
  core + DOM + tags at or below 13 KB gzipped.

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
pnpm test        # the whole suite, including the perf/size/granularity budgets
pnpm check       # strict TypeScript across packages, examples, and the site
pnpm build:site  # the static site, as GitHub Pages publishes it
```

## Learn it

| doc | what it is |
|---|---|
| [Thinking in processes](docs/tutorial.md) | build a cart locally, then move it to a server |
| [Concepts](docs/concepts.md) | the reference: each concept, its contract, its tests |
| [Recipes](docs/recipes.md) | typeahead, forms, query cache, routing, undo/redo, drag, durability |
| [Testing](docs/testing.md) | driving generators directly, transcripts, views as data |
| [Migration](docs/migration.md) | coming from React, Solid, or LiveView |
| [Processes on the server](docs/server.md) | virtual actors, durable execution, agent loops, and current limits |
| [Hosting safely](docs/hosting.md) | authentication, browser origins, and deployment boundaries |
| [Protocol](docs/PROTOCOL.md) | the data wire and conformance rules |
| [Examples](examples/README.md) | the demo ladder |
| [Internals](docs/internals/README.md) | contributor notes: how core is built, and its invariants |

## Packages

| package | contents |
|---|---|
| `@nonchalant/core` | `Process`, `spawn`, `derive`, the registry, `reconcile`, the reactive graph. Zero dependencies, no DOM. |
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
