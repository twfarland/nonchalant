# Nonchalant — design handover

**This file is the canonical context.** It condenses three review/design sessions
(August 2026) so work can continue here without the original conversation. The full
illustrated proposal (draft 3.1) is `design-proposal.html` in this directory, also
published at: https://claude.ai/code/artifact/1ceba076-c67e-49a9-85ff-a6fc7b37c21d

## Origin

Tim Farland's 2016 libraries — **sprezzatura** (vdom), **acto** (FRP signals), and
**sprezzatura-acto-mario** (Elm-Mario demo, sibling dirs `../sprezzatura` etc.) —
were reviewed and retired as artifacts. Their systemic flaws, which this design
exists to make structurally impossible:

1. **No resource lifecycle.** acto's `stop()` didn't propagate either direction —
   every derived signal was retained by its root forever; `fromAnimationFrames` was
   unstoppable; sprezzatura had a `mounted` hook but no unmount.
2. **Types described intent, not runtime.** `Signal<T>` actually carried `T | Error`;
   VDom "2-tuples" got a third element written into them; no strict mode.
3. **No consistency model.** Naive push propagation → diamond glitches; Mario's
   physics double-stepped on key-repeat (acto's `map` was combineLatest with holes).
4. Sprezzatura built DOM via `innerHTML` string concat: XSS by construction, tables/
   SVG silently broken, `mounted` fired on detached nodes, adjacent text joined with
   a stray space, keys of 0 fell through, updateDom returned wrong nodes on 2 paths.

Also researched (2026 SOTA): **alien-signals** (source read; the push–pull core to
port), **Solid 2.0** (first-class async shipped May 2026 — `createProjection` takes
`Promise | AsyncIterable`; "async signals" is TAKEN as a differentiator),
**Crank.js** (generator components, but vdom+JSX), **Phoenix LiveView** (statics/
dynamics wire, but BEAM-only + HTML wire), **Svelte 5 runes** (plain-`let` needs a
compiler — settled), **Effection 4** (structured concurrency ownership model),
**TC39 signals** (Stage 1; `watched`/`unwatched` hooks legitimize refcounting).

## The thesis

**A process is an async generator.** Its state is plain `let` locals on a suspended
frame. It communicates only by receiving messages and yielding values — so it does
not know which side of the wire it runs on. Everything is a `Process`: state is a
process of data, a view is a process of UI, a derivation is a process with no
mailbox, a remote actor is a process whose yields arrive over a socket.

**The claim:** the first library where state is addressed by name, and a name
resolves identically in this tab, a worker, or a server — on a protocol any language
can host, feeding a renderer that need not be a DOM. NOT "faster signals", NOT
"async signals" (Solid owns that since May 2026).

## The design (draft 3, settled)

Read `DECISIONS.md` for the ledger with rationale. The load-bearing pieces:

### One type, three constructors, one sink
- `Process<T, In>`: callable `p(): T` (sync read of latest yield), `send` (casts),
  `ask` (calls, typed via `Call<Req,Res>` messages carrying `reply`), async-iterable
  (lossy latest-value multicast), disposable (recursive scope teardown), plus
  `pending` / `stale` / `error`.
- `spawn(proc, args, {initial?})` — `initial` decides `Process<T|undefined>` vs
  `Process<T>` in the type. `connect(url) → Registry`. `derive(fn)` — pure memoised.
  `mount(sink, view)`. `cell(initial)` is 5-line sugar over spawn, not a primitive.
- Inside face `Self<In>`: FIFO backpressured mailbox (`for await`), `latest()`
  (drop-stale, = flatMapLatest), `signal: AbortSignal`, `send` (self-send).
- **Pull vs subscribe rule:** inside a generator body, `cart()` is a snapshot pull —
  no subscription. Subscription is iteration (`for await (c of cart)`). Only
  derive/bindings/effects auto-track.

### Write plain, read tracked (the granularity mechanism)
Every yield: `patch = reconcile(prev, next)` → snapshot ← next → notify only readers
whose recorded paths intersect the patch ops. Reads inside tracked contexts return
the snapshot behind an **ephemeral get-only proxy** recording touched paths; raw
snapshot elsewhere (zero overhead). No write traps, no reactive/raw identity split —
deliberately dodges Vue's proxy scar tissue. Immutable-update style (`let` + spread)
makes reconcile nearly free via `===` short-circuit; this is the same codec the wire
uses, so **local and remote updates are literally the same code path**.

### Registry (the missing concept found in review)
`lookup(name, args)` = get-or-spawn. One operation is simultaneously DI (no prop
drilling), query caching (composite keys = TanStack queryKey; watcher refcount +
`evict` idle timeout = SWR lifecycle), and remote addressing (`connect` returns a
Registry; the typed schema is also the security whitelist).

### Ownership
Anything spawned inside a process body attaches to that process's scope, dies with
it recursively. Transient/closed-over processes (the useState case) are anonymous
spawns owned by the enclosing scope — Counter widgets, drag interactions. Shared
state goes through the registry, owned by watchers. Per-row processes on 10k rows =
documented anti-pattern (processes model state/structure; nodes model the rest).

### Views
Function-call constructors `div({attrs}, ...children)` returning plain typed data
(`VNode`); sinks interpret (dom/canvas/terminal/test). View processes yield ONCE
(a tree of bindings — holes are thunks/processes); re-yield only for structural
change; re-yield-per-value is a detectable perf bug. Keyed lists: one honest
localized diff in the sink (like Solid `For`); splice patch ops can drive DOM
splices directly. JSX = optional ~50-line adapter. No compiler; thunk tax
`() => cart().total` accepted and priced.

### Wire (rev 2) — see PROTOCOL.md
8 ops (lookup/send/call/exit | yield/reply/done/raise), patches only, never markup,
never code. Reconnect = full patch from root (not a special case). `predict` option:
run the same generator as a local twin for optimistic UI, rebase on authoritative
patches (v1: flag-gated; needs splice-vs-splice property tests first).

### Supervision
`restart` policy on spawn; readers keep last value with `stale: true` during crash;
casts retained in bounded mailbox (drop-oldest) and replayed; pending asks REJECT.
Init args are the recovery state (Erlang position). No preemption — named as a gap;
worker-thread hosts partition blast radius; language-agnostic protocol is the hedge.

## Measured (Node v22.12, this machine)

- 100k async generators: spawn+first-yield 220ms (~2.2µs each), one tick 91ms
  (~0.9µs), ~1.4KB each. "Node can't do actors" is false; missing preemption, not throughput.
- reconcile prototype (now `packages/core/src/reconcile.ts`): 1-of-10k immutable
  change **46µs**; append **38µs**; 1-of-100k **759µs**; zero-sharing 10k **~4.9ms**
  (the pathology — dev build should warn "yields share no structure"); small-state
  zero-sharing **3.8µs**. Identity-guard-before-recursion was worth 5×.
- Guidance: interaction-rate yields fine at any size; frame-rate yields want
  frame-sized state (Mario = five numbers).

## Verified

`packages/core/test/types.check.ts` — the full type surface compiled under
`tsc --strict` on **TypeScript 7.0.2** including negative cases (@ts-expect-error is
load-bearing): cast/call separation, initial→totality, registry arity, combinator
passthrough. This file is the contract the runtime must satisfy.
`packages/core/test/reconcile.test.ts` — property tests pass (apply∘reconcile→next,
input immutability, sharing short-circuit, __proto__ guard).

## What's here vs what's next

Here: verified types, working+tested reconcile, protocol spec, benches, this dump.
Next: ROADMAP.md M1–M9 (graph port → process runtime → dom → registry → wire →
host → Mario golden → docs). M1 (reconcile hardening) landed: RFC 6901 escaping,
prefix/suffix splice detection, minimality property tests, CI perf budget.
M2 (the graph) landed: alien-signals core ported 1:1 (core/src/system.ts); path
precision implemented as per-reader *gate* signals — publish tests the patch
against each reader's recorded PathTree (core/src/track.ts) and bumps only
affected gates, so granularity rides on stock equality-cut propagation rather
than a modified core; `derive` is a real Process (error surface, lossy async
iteration, dispose); effects flush on a microtask, `flush()` drains manually.
M3 (process runtime) landed: spawn publishes yields through a graph source
(process reads are path-precise in effects/derives); Self with FIFO mailbox,
burst-correct `latest()`, per-instance abort signal, self-send; `channel`;
ownership via ambient scope during the synchronous window of each resumption
(spawn before awaiting — spawns after an intervening await run unowned);
dispose order mailbox→finally→children; ask/reply with crash rejection;
restart-from-args with cast replay; bounded drop-oldest mailbox; leak suite
green (WeakRef + `gc({execution:'async'})` — plain gc() false-fails under V8
conservative stack scanning). Q3 mailbox-overflow is now implemented as decided.
M4 (dom) landed: @nonchalant/dom with /tags + h(); the sink renders static
structure once and drives each thunk/process hole as a marker-anchored region
with one effect (items built `untracked` so reused items' bindings survive
region re-runs); keyed diff per DECISIONS #14; per-slot pending/error; exit
hook; sprezzatura regressions green; granularity CI-asserted by counting
Text#data writes (happy-dom's MutationObserver misses characterData).
Playwright layer deferred to pre-M8.
M5 (registry) landed: define/registry over the verified Registry<S> type;
lookup get-or-spawn keyed by name + stable args serialization; watcher
refcount = the process source's gate count (an internal onWatchers hook),
driving evict idle timers; registry spawns are unscoped (not owned by the
looker-upper); the query-cache recipe is a passing test; regions accept
promise values (lazy routes supersede stale loads).
M6 (wire) landed: codec with direction filtering (bus-safe); memoryPair
with controllable partitions; expose() hosts a registry using only the
public Process face (a lossy iterator per watched ref — patches between
observed snapshots always compose; first yield after any lookup is a full
snapshot); connect() makes each remote ref a local pump process — patches
arrive in its mailbox and every application is a yield, so remote reads
get the whole local machinery including path-precise tracking, raise
crashes the pump into stale reads, and the reconnect re-lookup's full
patch diffs against the retained value (readers of unchanged paths sleep
through reconnect — tested). WebSocket (reconnecting) and BroadcastChannel
transports; conformance vectors (spec/README.md defines the format and the
canonical counter process) run in CI as the cross-language contract.
M7 (host) landed: serve(defs) hosts over real WebSockets (dep: ws); a
connection is a session (own expose; teardown on disconnect releases
watches into registry refcounting); GET /schema serves the name whitelist;
the pitch demo exists at examples/shared-cart (local→server = one line).
End-to-end tests run over real sockets, including remote path-precision.
Open questions: DECISIONS.md bottom (epoch scoping, predict scope, npm scope
claim).

## Voice and priorities (so future sessions match)

- Honesty over slogans: "no vdom" means no whole-tree sweep, not no list diff.
  Budgets are measured and CI-asserted, not aspirational.
- Few primitives; everything else userland with no privileged access. New concepts
  must earn their place by dissolving ≥2 existing problems (the registry test).
- The old libraries' bug list is the regression suite. Mario is the golden demo and
  must fix the double-step bug. The pitch demo is the one-line local→server move.
