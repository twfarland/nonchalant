# Contributing

Nonchalant is experimental. Issues and pull requests are welcome; for anything
larger than a fix, open an issue first so the design can be discussed before
the code.

## Setup

Node 22 or newer and pnpm (the version is pinned in `package.json`; `corepack
enable` picks it up).

```sh
pnpm install
pnpm check        # strict tsc, the no-DOM package boundaries, and the doc samples
pnpm test         # vitest: unit, property, leak, perf, size, and golden budgets
pnpm dev          # the doc site at /, the example gallery at /examples/
```

CI (`.github/workflows/ci.yml`) runs `pnpm check` and `pnpm test` on Node 22
and 24 for every push and pull request, plus `pnpm verify:pack`. A pull request
is ready when both are green locally.

| command | what it does |
|---|---|
| `pnpm check` | `tsc --noEmit` over everything; `check:boundaries` compiles core, wire, and durable without the DOM library (and host against Node only); `check:docs` type-checks the TypeScript samples in `README.md` and `docs/` |
| `pnpm test` | the whole suite, including every budget |
| `pnpm build` | builds each package to `dist/` (`.js` + `.d.ts`), in dependency order |
| `pnpm verify:pack` | builds, packs each package as `pnpm publish` would, and lints the tarballs with publint and are-the-types-wrong |
| `pnpm build:site` | the static doc site and gallery, as GitHub Pages publishes it |
| `pnpm changeset` | records a user-visible change for the next release |

## Rules that CI enforces

- **Budgets are assertions. Tighten them if you can; never loosen one to make a
  change fit.** They live in `packages/core/test/reconcile.perf.test.ts`,
  `examples/mario/mario.golden.test.ts`, `test/size.test.ts`,
  `test/room-memory.test.ts`, and `packages/core/test/process.leaks.test.ts`.
  If a change cannot fit, find a leaner design.
- **The wire spec is a cross-language contract.** Changing the protocol or
  patch semantics means updating `packages/wire/spec/` vectors and
  `packages/wire/spec/README.md` together; external hosts certify against
  those files.
- **Package boundaries.** `packages/core`, `packages/wire`, and
  `packages/durable` never touch the DOM or Node-only APIs: they compile
  against `types/universal.d.ts`, the globals every host shares. If a package
  needs a new universal global, add it there.
- **`packages/core/src/system.ts` is a port of alien-signals** and stays 1:1
  with upstream; changes to the reactive layer go in `graph.ts`.
- **The type surface is tested.** The `@ts-expect-error` lines in
  `packages/core/test/types.check.ts` are load-bearing; if one stops erroring,
  the types broke.
- **Doc samples compile.** Every ```` ```ts ```` block in `README.md` and
  `docs/` is type-checked. A sample that leans on earlier context declares it
  in a `<!-- ts-prelude ... -->` comment above the fence; a deliberate fragment
  is marked ```` ```ts nocheck ````. See `scripts/check-doc-samples.ts`.

## House style

`CLAUDE.md` is the full style guide, for humans and agents alike. The short
version:

- No semicolons, 2-space indent, single quotes. Strict TypeScript, no `any` in
  public signatures, ESM only.
- Comments state constraints the code cannot; no narration, no history.
- Message handling is `switch (msg.type)` with one named `case` per member.
- Immutable updates (`let` + spread), never mutate-then-clone.
- Test names describe behavior in plain words; assertions use exact counts
  where the mechanism promises exactness.
- Docs are plain and concrete; a claim about performance points at the test
  that enforces it. Every code sample is TypeScript.
- A new public concept must dissolve at least two existing problems;
  otherwise it is a recipe in `docs/recipes.md`.

## Changes and releases

Nothing is published yet. For a user-visible change, run `pnpm changeset` and
commit the file it writes; the packages version together. Contributor notes on
how the core mechanisms work are in `docs/internals/`; update them when you
change a mechanism.

Security issues: see [SECURITY.md](SECURITY.md), not the issue tracker.
