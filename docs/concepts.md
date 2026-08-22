# Concepts

The reference. One noun, two faces, a handful of operations — each entry names
its contract and where the tests that enforce it live.

## Process (the outside face)

`Process<T, In>` — what a holder of a process can do:

| member | contract |
|---|---|
| `p()` | Synchronous read of the latest yield. Tracked (path-recording) inside derive/bindings/effects; a plain snapshot pull anywhere else. |
| `p.send(msg)` | Cast: fire-and-forget. Present only when `In` has plain messages. |
| `p.ask(msg)` | Call: typed request/response. Present only when `In` has `Call` messages. Rejects on crash, completion, overflow-drop, dispose. |
| `p.pending` | Working towards its next yield (mailbox-driven). |
| `p.stale` | Value survives a crash or a partition; cleared by the next good yield. |
| `p.error` | Last failure, if any. |
| `for await (v of p)` | Lossy latest-value stream; each iterator is an independent subscription. |
| `p[Symbol.dispose]()` | Ends the process: mailbox closes, `finally` runs, owned children die — in that order. |

Tests: `packages/core/test/process.test.ts`, `types.check.ts` (the compile-time
contract, `@ts-expect-error` lines load-bearing).

## Self (the inside face)

What the generator receives: `for await (msg of self)` (FIFO, backpressured),
`self.latest()` (skip to newest, dropping the queue — flatMapLatest as an
iteration mode), `self.signal` (aborts on dispose/crash — thread it into every
fetch), `self.send` (self-send). `channel(signal?)` is a standalone Self for
middleware and tests.

## spawn

`spawn(proc, args, opts?)`. `opts.initial` decides `Process<T>` vs
`Process<T | undefined>`. `opts.restart: 'on-crash'` re-runs from `args` (the
recovery state) up to `maxRestarts`; queued casts replay; pending asks reject.
`opts.mailbox: n` bounds the queue, drop-oldest, with a dev warning.

Ownership is ambient: a spawn during the synchronous window of a process
resumption attaches to that process and dies with it, recursively. Spawn
before awaiting — a spawn after an intervening `await` in the same step runs
unowned. Registry processes are deliberately unowned (shared state belongs to
its watchers, not its first caller).

## derive

`derive(fn)` — pure, memoised, no mailbox; a full `Process<T>` (readable,
iterable, disposable, error-carrying). Recomputes when tracked dependencies
change; propagates only when its value changes (the equality cut).

## The graph (why granularity is exact)

Every yield: `patch = reconcile(prev, next)` → snapshot ← next → wake only
readers whose recorded paths intersect the patch. The propagation core is a
faithful port of alien-signals (`core/src/system.ts`); path precision rides on
it untouched via per-reader *gate* signals. The read proxy is ephemeral and
get-only: a primitive read depends on its exact path; a container traversed
into is not itself a dependency; a container obtained but never read into is a
subtree dependency; keys/length/`in` are structural. Effects flush once per
microtask; `flush()` drains synchronously; derives are pull-consistent either
way (no glitches — diamond-tested).

Tests: `graph.test.ts` (exact wake counts, glitch freedom),
`reconcile.test.ts` (property-based round-trip, splice minimality),
`reconcile.perf.test.ts` (1-of-10k ≤ 100 µs, CI-asserted).

## Views and sinks

Views are function calls returning plain typed data (`VNode`); sinks
interpret. A view process yields once — a tree whose holes (thunks/processes)
are marker-anchored regions, each driven by one effect. The keyed diff is
localized and honest: reference-equal vnodes skip, `key: 0` keys by presence,
moves move DOM nodes, removals defer through the `exit` hook. Promise slots
hold only their own region (pending = empty, rejection = contained); throwing
bindings keep previous content. No string is ever parsed as markup — the
sprezzatura XSS/table/SVG bug class is structurally gone.

Budgets are CI-asserted: one view yield and ≤ 3 DOM writes/frame for Mario
(`examples/mario/mario.golden.test.ts`); one text write for one label change
in a 50-row list (`packages/dom/test/dom.test.ts`).

## Registry

`registry(defs)` / `define(proc, opts)` / `lookup(name, args)` — get-or-spawn,
keyed by name + order-insensitive args serialization. Watchers (subscriptions,
not pulls) refcount the entry; `evict` (opts) idles it out after the last
watcher leaves; `evict(name, args?)` is manual. One concept = DI + query cache
+ remote addressing. Tests: `registry.test.ts` (including the query-cache
recipe).

## Wire

Eight ops (`lookup/send/call/exit` | `yield/reply/done/raise`), JSON, patches
of plain data — never markup, never code. `expose(reg, transport)` hosts;
`connect(transport)` returns a Registry whose processes are local pumps —
patches arrive in a mailbox, every application is a yield, so remote reads get
the entire local machinery including path precision. Reconnect = re-lookup +
full snapshot, diffed against the retained value. Conformance vectors under
`packages/wire/spec/` are the cross-language contract. `@nonchalant/host`
serves it over real WebSockets; each connection is a session.

## Budgets (all CI-asserted)

| budget | where |
|---|---|
| reconcile 1-of-10k ≤ 100 µs (median) | `reconcile.perf.test.ts` |
| Mario: 1 view yield, ≤ 3 DOM writes/frame, 0 structural ops | `mario.golden.test.ts` |
| core ≤ 8 KB gzip; core+dom+tags ≤ 13 KB; wire ≤ 9.5 KB | `test/size.test.ts` |
| nothing retained after dispose | `process.leaks.test.ts` |
