# Nonchalant

Nonchalant is an experimental TypeScript runtime for stateful async-generator
processes, with optional DOM and wire packages. A process owns ordinary local
state, receives messages sequentially, publishes snapshots, and has an
explicit lifetime. `spawn` returns a typed handle that you can read, send to,
ask, iterate, and dispose.

The project explores a specific idea: can the same state-owning unit work for
widget state, shared application state, cached work, state reached over a
transport, and work that runs on a server — an agent loop, a durable workflow —
without becoming a different thing at each layer? It is not a React-compatible
component model, an Erlang runtime, or a complete query client. The useful part
is the combination of sequential messages, fine-grained snapshot reads,
ownership, and a small data-only wire.

**[twfarland.github.io/nonchalant](https://twfarland.github.io/nonchalant/)** —
the short version, with the demos running on the page and the whole example
gallery alongside it.

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

## Why this way

Generators uniquely combine three pieces: local state as ordinary `let` variables,
sequential input as `for await` messages, and an explicit lifetime (`return` or
`dispose`). This single unit scales—a cell's state machine is the same shape as
a cached query, which is the same shape as a process running on a server. One
process type, three distances. `registry.lookup` is dependency injection + query
cache + remote addressing rolled into one operation. Views run once; structure
never rebuilds; updates flow through the graph by path; everything is plain data
until it crosses a wire.

## What it offers

- **Views run once.** A view returns a tree with bindings in it, and never
  rebuilds. All the React muscle memory about defending against re-renders—
  memoization, dependency arrays, stable identities—has nothing to attach to.
  Structure that changes is expressed as keyed lists or swapped regions.

- **Fine-grained updates come free.** You write ordinary immutable updates;
  every yield is diffed structurally, and readers wake only if a path they
  actually read changed. This falls out of the model: immutable yield +
  structural diff + read tracking = no dependency arrays, no memos, no re-render
  tax. CI asserts that changing one label in a 50-row list is exactly one DOM
  write, and that a 60 fps game demo stays within one view yield and ≤ 3 DOM
  writes per frame.

```ts
s = { ...s, total: s.total + item.price }   // an ordinary immutable update
yield s                                     // diffed → only /total readers wake;
                                            // a binding on items[3].done sleeps through it
```

- **The mailbox serializes work by default.** A double-submit queues instead of
  racing; `latest()` conflates queued input to the newest value, while the abort
  signal handles lifetime cancellation.

```ts
for await (const { q } of self.latest()) {          // queued keystrokes conflate to the newest
  results = await api.search(q, { signal: self.signal })
  yield { q, results }
}
```

- **Request/response is typed end to end.** A message that expects an answer
  is a `Call`; `ask()` returns the reply as a promise and rejects if the
  process crashed. The compiler refuses to `send` a call or `ask` a cast.

```ts
type CartMsg =
  | { type: 'add'; item: Item }                                   // a cast
  | Call<{ type: 'checkout' }, { ok: boolean; charged: number }>  // a call

const res = await cart.ask({ type: 'checkout' })   // res is typed; crash = rejection
```

- **One interface for DI, caching, and remote addressing.** `lookup(name, args)`
  is simultaneously dependency injection (no prop drilling), query caching
  (name + args = TanStack's queryKey, with refcounting and idle eviction), and
  named addressing. `connect(transport)` substitutes the transport but keeps
  the interface; the same code works locally or over a wire. Real boundaries
  remain: arguments and values must be JSON, calls fail on network loss, and
  a deployed host needs authentication.

```ts
const shop = registry({ cart: define(cart) })                       // this tab
// const shop = connect<Shop>(portTransport(new Worker(url)))       // another thread
// const shop = connect<Shop>(broadcastChannelTransport('shop'))    // another tab
// const shop = connect<Shop>(webSocketTransport('wss://…'))        // another machine
```

- **Processes test as transcripts.** `Self` is an interface and `channel()`
  implements it, so a process tests as the plain generator it is — no
  runtime, no fake timers, no DOM ([docs/testing.md](docs/testing.md)).

```ts
const self = channel<Msg>()                  // a scripted mailbox
self.send({ type: 'add', title: 'milk' })
const it = todosProc(self, undefined)
expect((await it.next()).value.todos).toHaveLength(1)
```

- **A language-agnostic wire.** Eight JSON ops carrying state patches — never
  markup, never code. The conformance vectors in `packages/wire/spec/` are the
  contract; any language can implement the host half.
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

Every row is a different set of trade-offs, not a scoreboard. What nonchalant
gives up is listed in the [migration guide](docs/migration.md): no JSX
ergonomics without an adapter, explicit thunks for reactive expressions, no
BEAM-style preemption.

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
| [Thinking in processes](docs/tutorial.md) | the tutorial — build a cart, end with it on a server |
| [Concepts](docs/concepts.md) | the reference: each concept, its contract, its tests |
| [Recipes](docs/recipes.md) | typeahead, forms, query cache, routing, undo/redo, drag, durability |
| [Testing](docs/testing.md) | driving generators directly, transcripts, views as data |
| [Migration](docs/migration.md) | coming from React, Solid, or LiveView |
| [Processes on the server](docs/server.md) | virtual actors, durable execution, and agent loops — with the limits stated |
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

- [alien-signals](https://github.com/stackblitz/alien-signals) (Johnson Chu,
  MIT) — the push–pull propagation core is a faithful port; the path-precision
  layer sits on top of it, untouched.
- [Crank.js](https://crank.js.org) — a major influence: the proof that
  generator components with plain-local state feel right. Nonchalant keeps the
  generator and swaps the vdom re-render for fine-grained bindings, a mailbox,
  and the wire.
- **Erlang/OTP** — inspiration for mailboxes, casts vs calls,
  restart-from-init-args, ownership, and named processes. Nonchalant does not
  provide process isolation, preemption, escalation, or OTP supervision trees.
- **The Elm architecture** — the model/update/view lineage several of the
  examples follow.
- **Solid** and **lit-html** — prior art for the localized keyed diff.
- **Phoenix LiveView** — prior art for server-held UI state; nonchalant's wire
  carries data patches instead of HTML.
- **TanStack Query** — prior art for cache keys, sharing, watcher counts, and
  idle eviction. The registry implements those lifecycle pieces, not the full
  product surface of a query client.
- [7GUIs](https://eugenkiss.github.io/7guis/) (Eugen Kiss), **TodoMVC**, and
  the [krausest js-framework-benchmark](https://github.com/krausest/js-framework-benchmark)
  — the example and benchmark suites implemented in `examples/`.

MIT © Tim Farland
