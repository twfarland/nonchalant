# CLAUDE.md — nonchalant

A UI library built on one primitive: a **Process** (written as an async
generator — plain-`let` state, message in, yields out; `spawn` runs it and
returns the typed handle; location-transparent). Read `docs/concepts.md` for
the model; `README.md` is the front page.

## Commands
- `pnpm check` — strict tsc over all packages, examples, and tests
- `pnpm test` — vitest (unit, property, leak, perf, size, and golden budgets)
- `pnpm dev` — vite; opens the example gallery at /examples/
- `pnpm cart-server` — the shared-cart demo's WebSocket host

## Hard rules
- `strict` TS everywhere; zero `any` in public signatures. The
  `@ts-expect-error` lines in `packages/core/test/types.check.ts` are
  load-bearing regression checks — if one stops erroring, the type surface
  broke.
- No committed build output. ESM only. `packages/core` must never touch the
  DOM; `packages/wire` must stay isomorphic and DOM-free (host-universal
  globals like AbortSignal/WebSocket via `globalThis` are fine).
- Immutable-update style in examples and docs (`let` + spread) — structural
  sharing is what makes reconcile O(changed). Mutate-then-clone is the
  documented anti-pattern.
- **Budgets are CI assertions. Tighten them if you can; never loosen one to
  make a change fit.** They live in: `reconcile.perf.test.ts` (1-of-10k
  ≤ 100µs), `examples/mario/mario.golden.test.ts` (1 view yield, ≤ 3 DOM
  writes/frame, 0 structural ops), `test/size.test.ts` (gzip bundle caps),
  `process.leaks.test.ts` (nothing retained after dispose).
- `packages/wire/spec/` is a cross-language contract. Changing the protocol or
  patch semantics means updating the vectors and `spec/README.md` together —
  external hosts certify against those files.
- `packages/core/src/system.ts` is a faithful port of alien-signals (MIT,
  attributed). Keep it 1:1 with upstream semantics; layer changes go in
  `graph.ts`, not the core.
- New public concepts must dissolve at least two existing problems to earn a
  place (the registry earned its spot by being DI + query cache + remote
  addressing at once). Prefer userland recipes — `docs/recipes.md` is where
  patterns live.

## Conventions
- House style: no semicolons, 2-space indent, single quotes. Comments state
  constraints the code can't; no narration, no history.
- Test names describe behavior in plain words; assertions prefer exact counts
  over "at least" where the mechanism promises exactness (wake counts, DOM
  writes, re-eval counts).
- Docs are plain and concrete; claims about performance or granularity must
  point at the test that enforces them. Every code sample anywhere — docs,
  READMEs, demo-page explainers — is TypeScript, never untyped JS.
- Don't reference a concept before it's introduced (docs and READMEs read top
  to bottom).

## Writing nonchalant code (the style guide)

State:
- One process owns one piece of state. Its message type is a discriminated
  union (casts, plus `Call<Req, Res>` where the sender needs an answer); the
  generator body is the reducer; one yield per state change.
- Immutable updates, always: `let` + spread, sharing everything that didn't
  change. That sharing is what makes diffs O(changed).
- Keep computation out of the loop: pure helpers (`step`, `visible`) in their
  own exports, testable as plain functions.
- Time and dependencies arrive from outside: ticks and clocks as messages,
  APIs as args, `self.signal` threaded into every fetch. This is what makes
  tests deterministic.
- Spawn before awaiting (ambient ownership only covers the synchronous window)
  and remember a process that returns is over — a view process that owns state
  idles on its mailbox until disposed.

Views:
- Break substantial views into small named sub-view functions — one component,
  one concern — composed in an `App()` at the bottom. Components take their
  process(es) as parameters.
- Blank lines between substantial blocks; `// ---------- section ----------`
  dividers between a file's regions (state / components / the app).
- Values flow through bindings (thunks and processes in the tree); the view
  function runs once. Re-yield only for structural change. Keyed lists get
  stable keys.
- Reads outside tracked contexts are snapshots — subscribe deliberately
  (bindings, `derive`, `effect`, or iteration), never by accident.

Structure:
- Separate the schema/state module from the view module when either is
  substantial (`todos.ts` + `main.ts`, `shop.ts` + `main.ts`) — the state
  module is where the headless tests attach.
- Shared or cached state goes through a registry by name; widget state is a
  closed-over spawn. Per-row processes in big lists are the documented
  anti-pattern.
- New abstractions must dissolve at least two existing problems; otherwise
  write a recipe (`docs/recipes.md`). Operators, routers, and query caches
  are userland — keep them looking like it.
- Example pages carry a "How it works" aside: short prose plus the
  load-bearing code, generated with the plain highlighter (keywords, strings,
  comments — nothing fancier).

## Map
- `packages/core` — types (`types.ts`), reconcile/patches, the reactive graph
  (`system.ts` port + `graph.ts` + `track.ts`), the process runtime
  (`process.ts`), the registry.
- `packages/dom` — `h.ts`/`tags.ts` constructors, `render.ts` sink.
- `packages/wire` — `protocol.ts` codec, transports, `client.ts` (connect),
  `host.ts` (expose), `spec/` conformance vectors.
- `packages/host` — the Node WebSocket host.
- `examples/` — the demo ladder (see its README); `mario/` and `7guis/cells`
  carry their own test files.

## Known sharp edges (leave signposts if you touch them)
- Ownership is ambient only during the synchronous window of a process
  resumption: spawn before awaiting, or the child runs unowned.
- Leak tests need `gc({ execution: 'async' })` — plain `gc()` false-fails
  under V8 conservative stack scanning.
- happy-dom's MutationObserver misses characterData; DOM-write tests spy on
  `Text#data` and `setAttribute` instead.
- A container that is both traversed and escaped records as traversal only
  (the read proxy can't see identity use) — documented approximation in
  `track.ts`.

## Status
Implementation and docs are complete and tested. Not yet done: npm scope claim
and first publish, Changesets, a hosted docs site, js-framework-benchmark
submission (the app exists in examples/).
