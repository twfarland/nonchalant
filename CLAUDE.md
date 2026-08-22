# CLAUDE.md — nonchalant

**Read `docs/DESIGN.md` first** — it is the canonical handover context (thesis,
settled decisions, measured budgets, verified type surface). Then `docs/ROADMAP.md`
for the build order and `docs/DECISIONS.md` for the why-ledger. The illustrated
proposal is `docs/design-proposal.html`.

## What this is
A UI library built on one primitive: a **Process** (async generator; plain-`let`
state; message in, yields out; location-transparent). Successor to the author's
2016 libraries sprezzatura + acto (sibling dirs, retired artifacts — their bug list
is our regression suite).

## Commands
- `pnpm check` — tsc --noEmit over all packages (type harness included)
- `pnpm test` — vitest (core reconcile property suite)
- `pnpm bench` — reconcile + process-scale benchmarks

## Hard rules
- `strict` TS everywhere; zero `any` in public signatures; the `@ts-expect-error`
  lines in `packages/core/test/types.check.ts` are load-bearing regression checks.
- No committed build output. ESM only. `packages/core` must never import DOM;
  `packages/wire` must stay isomorphic and DOM-free.
- Immutable-update style in examples/docs (`let` + spread) — it's what makes
  reconcile O(changed); mutation+clone is the documented anti-pattern.
- Perf budgets are CI assertions (see ROADMAP): reconcile 1-of-10k ≤ 100µs;
  Mario golden = 1 view yield, ≤ 3 DOM writes/frame.
- New public concepts must dissolve ≥ 2 existing problems to earn a place
  (the registry test). Prefer userland recipes over new primitives.

## Status
M0 done (types verified on TS 7.0.2; reconcile implemented + property-tested;
protocol spec drafted). M1 done (RFC 6901 escaping; splice detection; minimality
property tests; reconcile perf budget asserted in CI). M2 done (alien-signals core
ported; per-reader gate signals give path-precise wakes; tracked-read proxy;
`derive` as Process; microtask batching + `flush()`). M3 done (spawn/Self/channel;
yields publish through a source so process reads are path-precise; disposal
cascade; ask/reply; restart policies; bounded mailbox; leak suite green).
M4 done (@nonchalant/dom: tags + h(), region-based sink, keyed reconcile,
per-slot pending/error, exit hook; sprezzatura regression suite green;
granularity asserted by Text-write counting; counter + TodoMVC examples).
M5 done (define/registry; lookup get-or-spawn with queryKey-stable args;
watcher refcounting via source gates drives evict idle timers; query-cache
recipe test; typeahead/form/router/undo-redo examples). M6 done (codec;
memoryPair with partitions; expose/connect — remote refs are local pump
processes, so remote reads are path-precise and reconnect-as-full-patch
diffs against the retained value; WebSocket + BroadcastChannel transports;
conformance vectors in packages/wire/spec run in CI; multi-tab example).
M7 done (serve() Node host over ws; per-connection sessions; GET /schema
whitelist; shared-cart pitch demo — local→server in one line). M8 done
(Mario golden: budgets CI-asserted — 1 view yield, ≤3 DOM writes/frame,
0 structural ops; double-step bug fixed by construction + regression test;
canvas retarget demo). Next: M9 docs & polish.
