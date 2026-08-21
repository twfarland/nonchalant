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
protocol spec drafted). Next: M1 reconcile hardening, M2 alien-signals port.
