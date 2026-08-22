# Nonchalant

A UI library built on one primitive. A **process** is an async generator: its
state is plain `let` variables, its input is a mailbox, and everything it
`yield`s is published. State is a process of data; a view is a process of UI;
a server actor is a process on the other end of a socket. Same type, same
lifecycle, same rules.

```ts
import { spawn } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, span } from '@nonchalant/dom/tags'

const counter = spawn(async function* (self) {
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

## Why it's interesting

- **No render loop.** A view runs once and returns a tree of bindings. Updates
  flow through the graph to exactly the DOM they touch — the CI suite asserts
  that changing one label in a 50-row list is exactly one DOM write, and that
  the Mario demo stays within one view yield and ≤ 3 DOM writes per frame.
- **Fine-grained without a compiler.** You write ordinary immutable updates;
  every yield is diffed structurally, and readers wake only if a path they
  actually read changed. No proxies on your writes, no annotations, no build
  step.
- **State has an address.** `lookup('cart', { userId })` is get-or-spawn: the
  first caller starts the process, everyone else shares it. The same operation
  is dependency injection, a query cache (with refcounting and idle eviction),
  and remote addressing.
- **Location transparency, for real.** `connect(url)` returns the same
  registry interface. The pitch demo (`examples/shared-cart`) moves a cart
  from the tab to a server by changing one line — the process code doesn't
  change, because it never knew which side of the wire it was on.
- **A language-agnostic wire.** Eight JSON ops carrying state patches — never
  markup, never code. The conformance vectors in `packages/wire/spec/` are the
  contract; any language can implement the host half.
- **Small.** Core is 6.2 KB gzipped; core + DOM + tags is 10.6 KB. Both are CI
  budgets, not aspirations.

## Try it

```sh
pnpm install
pnpm dev       # opens the example gallery
pnpm test      # 134 tests, including the perf/size/granularity budgets
pnpm check     # strict TypeScript across packages and examples
```

## Learn it

| doc | what it is |
|---|---|
| [Thinking in processes](docs/tutorial.md) | the tutorial — build a cart, end with it on a server |
| [Concepts](docs/concepts.md) | the reference: each concept, its contract, its tests |
| [Recipes](docs/recipes.md) | typeahead, forms, query cache, routing, undo/redo, and more |
| [Migration](docs/migration.md) | coming from React, Solid, or LiveView |
| [Protocol](docs/PROTOCOL.md) | the wire spec, for any language |
| [Examples](examples/README.md) | the demo ladder, counter through Mario |

## Packages

| package | contents |
|---|---|
| `@nonchalant/core` | `Process`, `spawn`, `derive`, the registry, `reconcile`, the reactive graph. Zero dependencies, no DOM. |
| `@nonchalant/dom` | tag constructors, `h()`, the DOM sink, keyed reconciliation, `mount`. |
| `@nonchalant/wire` | the protocol, codec, transports (WebSocket, BroadcastChannel, in-memory), `connect`. Isomorphic. |
| `@nonchalant/host` | the Node host: `serve(defs)` over WebSockets. |

MIT © Tim Farland
