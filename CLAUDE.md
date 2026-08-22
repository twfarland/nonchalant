# CLAUDE.md — nonchalant

A UI library built on one primitive: a **Process** (async generator; plain-`let`
state; message in, yields out; location-transparent). Read `docs/concepts.md`
for the model; `README.md` is the front page.

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
  point at the test that enforces them.

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
