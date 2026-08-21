# Roadmap

Milestones are dependency-ordered; each lands with its tests. Perf budgets are CI
assertions, not aspirations.

- **M0 — bootstrap** ✅ repo, verified type surface, reconcile + property tests, benches, docs.
- **M1 — reconcile hardening**: RFC 6901 escaping; splice *detection* (move/insert in
  the middle currently degrades to per-index sets — acceptable, not optimal); op-count
  minimality bounds; CI perf budget (1-of-10k ≤ 100µs on CI hardware).
- **M2 — the graph**: port alien-signals core (262 lines, keep their constraints: no
  Array/Set/Map in hot path, no recursion); `derive`; tracked-read proxy with path
  recording; notification precision tests (assert exact wake counts per patch);
  diamond/glitch tests; microtask batching + `flush()`.
- **M3 — the process runtime**: `spawn`, `Self` (FIFO mailbox, `latest()`, `signal`,
  self-send), `channel`, disposal cascade, `ask`/reply, restart policies, bounded
  mailbox. Leak suite: FinalizationRegistry-based "nothing retained after dispose"
  (the acto lesson). types.check.ts stops being aspirational.
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
