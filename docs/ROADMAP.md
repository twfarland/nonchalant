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
- **M4 — dom**: tag constructors (`/tags`, `var_` escapes, `h()` for SVG/custom
  elements), the DOM sink, keyed reconciliation, per-slot pending/error, event
  binding, exit-transition hook. **The sprezzatura bug list as a regression suite**:
  XSS strings (`<img src=x onerror=…>`, attribute breakout), tables, SVG, `key: 0`,
  adjacent text nodes, empty-string children. Examples: counter, TodoMVC.
- **M5 — registry**: local ambient registry, `lookup` get-or-spawn, watcher
  refcounting, `evict`. Recipe test: the 20-line query cache. Examples: typeahead,
  form (+ask), router (+code splitting), undo/redo combinator.
- **M6 — wire**: codec, in-memory transport (= reference implementation), WebSocket +
  BroadcastChannel transports, reconnect-as-full-patch, **language-agnostic
  conformance vectors** (JSON in/out pairs under packages/wire/spec/vectors/ — a BEAM
  host certifies against the same files). Example: multi-tab sync.
- **M7 — host**: Node host, schema serving, supervision trees, session lifecycle.
  **The pitch demo**: shared cart — move state from tab to server by changing one line.
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
