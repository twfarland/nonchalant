# Roadmap

Milestones are dependency-ordered; each lands with its tests. Perf budgets are CI
assertions, not aspirations.

- **M0 — bootstrap** ✅ repo, verified type surface, reconcile + property tests, benches, docs.
- **M1 — reconcile hardening** ✅ RFC 6901 escaping (`~0`/`~1`, malformed escapes
  rejected at apply); splice detection via shared prefix/suffix trim — contiguous
  mid-array insert/removal is now exactly one splice (property-tested); same-length
  reorders (moves/swaps) still degrade to per-index sets — keyed reconciliation is
  the sink's job (M4); CI perf budget asserted (1-of-10k ≤ 100µs median,
  `reconcile.perf.test.ts`, override via RECONCILE_BUDGET_US).
- **M2 — the graph** ✅ alien-signals core ported faithfully (`src/system.ts`, their
  constraints kept: no Array/Set/Map in hot path, no recursion); node layer + `source`
  in `src/graph.ts` — each (source, reader) pair gets a hidden *gate* signal, publish
  reconciles prev→next and bumps only gates whose recorded paths the patch affects,
  so path precision rides on stock equality-cut propagation; tracked-read proxy with
  path recording (`src/track.ts`: leaf/structural/subtree dependency rules, splice
  index boundaries); `derive` with its full Process face (callable, error surface,
  lossy async iteration, dispose); notification precision tests assert exact wake
  counts per patch; diamond/glitch tests; microtask batching + exported `flush()`.
- **M3 — the process runtime** ✅ `spawn` drives the generator and publishes every
  yield through a graph `source` — process reads get path-precise wakes for free;
  `Self` (FIFO backpressured mailbox; `latest()` defers a microtask so same-tick
  bursts supersede, then drains to newest; per-instance `signal`; self-send);
  `channel` (standalone Self for middleware/testing); disposal cascade (mailbox
  closes → `finally` runs → owned children die, ambient sync-window ownership);
  `ask`/reply with rejection on crash/end/overflow; `restart: 'on-crash'` from init
  args with `maxRestarts`, queued casts replayed; bounded mailbox (drop-oldest +
  dev warning). Leak suite passes under `gc({execution:'async'})` (plain `gc()`
  false-fails on V8 conservative stack scanning — see process.leaks.test.ts).
  types.check.ts is no longer aspirational: spawn/derive/cell are real.
- **M4 — dom** ✅ tag constructors (`/tags` subpath with `var_` escape; `h()` for
  SVG/MathML/custom, namespace inferred down the tree, foreignObject returns to
  XHTML); the DOM sink — static structure renders once, every thunk/process hole is
  a marker-anchored region driven by one effect; keyed reconciliation (`key: 0`
  keyed by presence; reference-equal vnodes skipped; moves move nodes); per-slot
  pending/error (promise slots hold only their region; throwing bindings keep
  previous content); `on*` event binding; `exit` hook defers detach until it
  settles; `mount` takes VNode | thunk | view process, `domSink` adapts to core's
  `mount(sink, view)`. Sprezzatura regression suite green (XSS string + attribute
  breakout, tables, SVG, key 0, adjacent text, empty strings). Granularity asserted
  by counting Text writes (one label change in 50 rows = exactly one write; a /b
  patch never touches the /a binding). Examples: counter, TodoMVC (type-checked in
  CI). Deferred: the Playwright layer (focus/IME/event-order) and holes nested as
  items *inside* a hole's array value (holes belong in the tree; skipped with a
  dev warning) — revisit before M8.
- **M5 — registry** ✅ `define(proc, opts)` + `registry(defs)` over the verified
  `Registry<S>` type; `lookup` is get-or-spawn keyed by name + queryKey-stable args
  serialization; watchers = subscription gates on the process's value source
  (effects/derives/iterators count; snapshot pulls don't), refcount drives the
  `evict` idle timer (cancelled if a watcher returns); manual `evict(name, args?)`;
  registry processes spawn unscoped (shared state is not owned by its first
  looker-upper — tested). Recipe test: the query cache (dedup, sharing, idle
  eviction, refetch). Regions now accept promise *values* (lazy routes: a thunk
  returning `import(...).then(...)`; stale loads superseded). Examples: typeahead
  (latest() + abort), form (+ask), router (+code splitting), undo/redo (withHistory
  over `channel`).
- **M6 — wire** ✅ codec (encode/decode with structural validation; wrong-direction
  and garbage → null, safe on bus transports); `memoryPair` in-memory transport with
  controllable partitions (= reference implementation and test rig); `expose(reg,
  transport)` reference host using only the public Process face (one lossy iterator
  per watched ref; patches between observed snapshots; done/raise from iterator end);
  `connect(transport)` — each remote ref is a local pump process (patches apply in
  its mailbox, so the whole Process face incl. path-precise tracked reads is stock
  local machinery; raise crashes the pump → stale reads; infinite restart);
  reconnect = re-lookup + full patch, diffed against the retained value so readers
  of unchanged paths sleep through it (tested); WebSocket (reconnecting, backoff) +
  BroadcastChannel transports; **conformance vectors** under packages/wire/spec/
  vectors/ (patch semantics incl. escaping/pollution errors; scripted sessions over
  the canonical counter; format documented for non-JS hosts) run in CI. Example:
  multi-tab sync. Deferred: the WebSocket transport is untested until M7's Node
  host provides a server end.
- **M7 — host** ✅ `serve(defs, opts)` — Node host over real WebSockets (`ws`);
  each connection is a session: its own expose() over the shared registry, torn
  down on disconnect so registry refcounting/evict reclaims idle processes
  (session count observable, tested over real sockets — which is also where
  `webSocketTransport` earned its coverage and a close-notification bug fix).
  Schema serving: GET /schema returns the `{ protocol, names }` whitelist; the
  typed contract is the shared TS schema module. Supervision trees are not a new
  mechanism: M3 restart policies + ownership cascade, configured per definition.
  **The pitch demo landed**: examples/shared-cart — one isomorphic cart module;
  the tab flips from local registry to server by changing one line.
- **M8 — golden**: Mario ported from sprezzatura-acto-mario. Budget asserted in CI:
  one view yield total, ≤ 3 DOM writes per frame. Then the canvas sink and the same
  Mario unchanged on canvas — retargeting demonstrated, not asserted. Profile vs the
  Elm original (the old README's invitation, finally answered).
- **M9 — docs & polish**: site (tutorial "Thinking in processes"; concepts; recipes;
  protocol spec; React/Solid/LiveView migration guides); 7GUIs examples (cells last —
  it stresses derivations); js-framework-benchmark entry; size-limit budgets;
  Changesets; claim npm scope; first publish.

## Test architecture (summary)
- **core/reconcile**: property-based (apply∘reconcile → next; input immutability),
  adversarial vectors (__proto__), perf budgets.
- **core/graph**: glitch-freedom, batching, wake-count precision.
- **core/process**: lifecycle, leaks (FinalizationRegistry), mailbox semantics,
  ask rejection on crash, restart policies.
- **wire**: conformance vectors shared across host implementations.
- **dom**: happy-dom fast loop; Playwright for focus/IME/event-order; DOM-write
  counting via MutationObserver for granularity assertions.
- **golden**: Mario budgets; js-framework-benchmark.
