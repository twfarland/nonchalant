# Concepts

This reference describes each concept, its behavior, and the tests that enforce
that behavior.

## Process (from the outside)

Write a process as an async generator and run it with `spawn`. It returns
`Process<T, In>`, a handle to the instance that owns its mailbox,
its published snapshots, and its lifecycle. The handle is what you hold after
`spawn` or `lookup`:

| member | what it does |
|---|---|
| `p()` | Read the latest value synchronously. Inside a tracked context (a view binding, or `derive` and `effect`, both below), this also subscribes by path. |
| `p.cast(msg)` | Fire-and-forget message. Only exists if `In` has `Cast` messages. |
| `p.call(msg)` | Request/response, typed. Only exists if `In` has `Call` messages. Rejects if the process crashes, finishes, or is disposed. |
| `p.pending` | True while the process is working toward its next yield. |
| `p.stale` | True when the value survived a crash or a lost connection; clears on the next good yield. |
| `p.error` | The last failure, if any. |
| `for await (v of p)` | A live stream of values. Lossy on purpose: you always get the latest, never a backlog. |
| `p[Symbol.dispose]()` | Starts teardown immediately: closes the mailbox, aborts the signal, and requests generator return. Owned children are disposed after the generator settles. It does not wait for asynchronous `finally` work. |
| `await p[Symbol.asyncDispose]()` | Starts teardown and waits until this process and its owned-child finalizers have settled. |

`In` is a discriminated union whose members are spelled `Cast<Msg>` for a
one-way message and `Call<Req, Res>` for one that expects an answer:

<!-- ts-prelude
import type { Call, Cast } from '@nonchalant/core'
type Item = { name: string; price: number }
-->
```ts
type CartMsg =
  | Cast<{ type: 'add'; item: Item }>
  | Call<{ type: 'checkout' }, { ok: boolean; charged: number }>
```

`Call` adds the `reply` function the generator answers through; `Cast` marks
its absence (`reply?: never`), which is what lets the compiler route each
member to `cast` or to `call` and reject the other one.

Tests: `packages/core/test/process.test.ts`; the type rules are in
`types.check.ts`. Its `@ts-expect-error` assertions detect regressions if an
invalid operation starts compiling.

## Self (from the inside)

The generator receives `Self`. `for await (msg of self)` reads queued messages
in order. `self.latest()` drops older queued messages and returns the newest,
which is useful for typeahead input. `self.signal` is an AbortSignal triggered
by disposal or a crash, and `self.cast` posts to the process's own mailbox.
`channel(signal?)` gives you a disposable standalone mailbox for middleware
and tests.

## spawn

`spawn(proc, args, opts?)`. Options:

- `initial`: the first readable value. With it, `p()` is `T`; without,
  `T | undefined` until the first yield.
- `restart: 'on-crash'`: rerun the generator from `args` after a throw, up to
  `maxRestarts` times. Queued casts replay; pending and queued calls reject,
  and a rejected call never runs in the restarted instance.
- `mailbox: n`: cap the queue; overflow drops the oldest and logs a warning.

[Error handling](errors.md) lists what a crash, a restart, and each kind of
call rejection look like from the outside.

Ownership: whatever a process spawns belongs to it and dies with it. The
attachment happens during the synchronous part of each step. Spawn before
you `await`, or the child ends up unowned. One resumption outside a normal step
also owns its spawns: the one disposal causes by closing the mailbox, so a
`finally` that disposal runs can spawn cleanup work (a flush, a goodbye
message) that is disposed with the process, provided it spawns before its
first `await`. Registry processes are unowned
because shared state should not end with the caller that happened to start it.

Disposal is cooperative. The synchronous symbol establishes the teardown
point but cannot make an awaited promise settle. Use the async symbol when a
test, shutdown path, or resource handoff must know that finalizers have
finished. In either case, pass `self.signal` to long-running operations; if an
operation ignores abort and never settles, asynchronous disposal must wait for
it.

When a process returns, it has finished, and
its children are disposed with it. A view process that spawns page-local state
must therefore stay alive after its yield. It can wait on the mailbox
(`for await (const _ of self) void _`) and let whoever disposes you end the
wait. `examples/router/about.ts` shows the pattern.

## derive

`derive(fn)` creates a memoized computation with the full Process interface (readable,
iterable, disposable, `error`). It recomputes when something it read changes,
and notifies its readers only when its *result* changes. This equality check
prevents unchanged results from propagating through a chain of derivations.

## effect and untracked

`effect(fn)` runs `fn` now and again whenever something it read changes, and
returns a function that stops it. `fn` may return a cleanup, which runs before
each re-run and when the effect stops. Effects are for pushing state out to
something that is not a process: the document title, a scroll position, a
log. `untracked(fn)` runs `fn` without recording its reads, for the one read
inside a tracked context that should not subscribe.

## The graph (why updates are exact)

Every yield goes through the same pipeline: diff the new value against the old
(`reconcile`), keep the new snapshot, wake only the readers whose recorded
paths the diff touched.

```mermaid
flowchart LR
    Y["yield next"] --> R["reconcile(prev, next)<br/>= a patch of changed paths"]
    R --> G{"did this reader's<br/>recorded paths change?"}
    G -->|yes| W["recompute it"] --> E{"did its result<br/>change?"}
    G -->|no| S["it sleeps"]
    E -->|yes| D["its own readers wake"]
    E -->|no| S2["its readers sleep<br/>(the equality cut)"]
```

The propagation engine is a faithful port of alien-signals
(`core/src/system.ts`). The path tracking sits on top: reads inside a tracked
context go through a short-lived read-only proxy that records which paths were
used, and the diff is matched
against that record.

State should be JSON-shaped: objects, arrays, and primitives. Other values such
as a `Date`, a `Map`, or a class instance are handled as
an *atomic leaf*: reads return it untouched and changes compare by identity,
so it works locally. There is no path tracking inside it, however, and only JSON
crosses a transport, so such values don't survive a remote `lookup`.

Effects run in a batch once per microtask; `flush()` runs them immediately.
Derives do not need either mechanism. Reading one always gives a consistent answer (the diamond
test proves no half-updated values are ever visible).

Tests: `graph.test.ts` (exact wake counts, glitch freedom), `reconcile.test.ts`
(property-based round-trips, minimal splices), `reconcile.perf.test.ts`
(1 change in 10k items diffs in ≤ 100 µs, enforced in CI), `process.test.ts`
("non-plain immutable values are tracked as atomic leaves").

## Views and sinks

A view is a function call producing plain data (`VNode`); a sink turns it into
something real. The DOM sink renders static structure once; each thunk or
process in the tree becomes a small live region with its own effect. A binding
that returns a subtree (a thunk returning a `VNode`, or a view process yielding
one) is a **replaceable region**: when it produces a different tree, the sink
patches the region in place where tags match and replaces it where they don't,
and nothing outside the region is touched. Replaceable regions and keyed lists
are how structure changes, since the view function itself never runs again.
Lists reconcile by key within the list. Matching keys patch existing nodes,
`key: 0` is valid, identical vnodes are skipped entirely, and removals can wait for an `exit`
transition; an exiting element is marked `inert`, so it leaves the focus order
and the accessibility tree while it animates. Surviving nodes that are already
in relative order stay put and only the rest move: n − LIS moves for n
survivors whose longest increasing subsequence of old positions is LIS, the
minimum, using `moveBefore` where the browser has it so focus and animations
survive the move (`keyed.property.test.ts`; swapping two of 1,000 rows is two
moves, in `examples/js-framework-benchmark/bench.test.ts`). A write the DOM
already holds is skipped, so a binding that re-runs, or a row re-rendered with
fresh closures, costs a read. A promise in a slot occupies only its own slot while pending;
a binding that throws keeps its previous content and reports the failure.
`onRenderError(handler)` routes those reports to your error reporting instead
of the console.

Attribute values follow the platform: `false` and `null` remove an attribute,
`true` sets it to the empty string, and anything else is stringified. The
exception is `aria-*`, which takes enumerated strings rather than presence, so a
boolean there renders as `"true"` or `"false"` — an absent `aria-pressed` means
"not a toggle", which is not what `false` is claiming.

Strings are never parsed as markup: text becomes text nodes and attribute
values go through `setAttribute`, so HTML in application data remains inert
text. Two attribute-level routes are closed as well: a `javascript:` URL in
`href`, `src`, `action`, `formaction`, or `xlink:href` is removed (checked
after stripping the control and space characters browsers ignore), and an
`on*` attribute accepts only a function, never a string of script. Other URLs
pass through as given, so treat user-supplied URLs as untrusted (the sink's
attribute policy is listed under `@nonchalant/dom` in the
[API reference](api.md#nonchalantdom)).

Attributes are typed per tag: `input({ value })` checks `value`, a misspelled
or camelCase listener (`onClick`) is a type error, and a listener's
`currentTarget` has the element's type. SVG listeners are typed but SVG
attributes are not, since the DOM lib doesn't describe them. For a tag or
attribute the DOM lib doesn't know, `h(tag as string, attrs)` takes untyped
attributes.
Tests also cover tables, SVG, and other common string-renderer failure modes,
in `packages/dom/test/dom.test.ts`.

There is no server-side rendering or hydration yet. The DOM sink builds every
node on the client; a server holds processes and sends state over the wire,
never HTML.

CI limits these paths to one text write for one changed label in a
50-row list (`dom.test.ts`); one view yield and at most 2 DOM writes per frame
for Mario (`examples/mario/mario.golden.test.ts`); and exact insert, move,
write, and listener counts for each js-framework-benchmark operation on 1,000
rows (`examples/js-framework-benchmark/bench.test.ts`).

## Registry

`registry(defs)` + `define(proc, opts)` + `lookup(name, args)`. Lookup is
get-or-spawn, keyed by name plus the arguments. Argument order is ignored, so `{a, b}`
and `{b, a}` are the same key. A read returns `T | undefined` until the first
yield, unless the definition has `initial`. Subscribers to values or lifecycle
metadata count as watchers: an effect, or a derive or iterator an effect reads
through. Plain reads don't, and neither does a derive that is only ever read
as a snapshot. The idle timer starts at lookup and
restarts when the last watcher leaves; after eviction the next lookup starts
fresh. `registry(defs, { maxEntries })` caps the cache: past it, the least
recently looked-up unwatched entries are disposed, so distinct arguments cannot
grow memory without bound. One mechanism, three jobs: dependency
injection, query caching, and remote addressing over a transport.
Tests: `registry.test.ts`.

## Wire

Eight JSON ops (`lookup/cast/call/exit` from the client, `yield/reply/done/
raise` from the host), carrying state patches rather than markup or code.

```mermaid
flowchart LR
    subgraph client
        B["bindings and derives"] --> F["Process handle<br/>(a local patch-applying process)"]
        F -->|"cast / call"| T["transport"]
        T -->|"yield: patch"| F
    end
    subgraph host
        T2["transport"] --> X["expose()"]
        X -->|"lookup = get-or-spawn"| REG["registry schema<br/>(the whitelist)"]
        REG --> P[["the process"]]
        P -->|"yields → reconcile → patches"| X
    end
    T <--> T2
```
`expose(reg, transport, opts?)` serves a registry or any object with a
`lookup` method, which is the seam per-connection scoping uses. The same
gateway can `admit` each client message (pass it through, replace it, or
refuse it) and carry a `principal` that namespaces the session's call ids.
`opts` carries `maxWatches` to cap how many refs one session may hold open and
`lookupRate` to limit how fast it may look them up. The full list is in the
[API reference](api.md#nonchalantwire).
`connect(transport)` gives you the same lookup interface backed by the other
side. Under the hood each remote process is a local process that applies
incoming patches. Remote reads therefore keep the same path-level precision as
local reads. A host crash appears as `stale: true`; reconnecting repeats the
lookup, receives the full state, and compares it with the retained value. The WebSocket transport redials automatically with exponential
backoff jittered to 50–100% of each step so a fleet of clients doesn't
stampede a restarting host; `retryDelay` tunes the base. A transport is only
`send` plus `subscribe`, so the port to a Web Worker is one as well:
`portTransport(new Worker(...))` here, `portTransport(workerEndpoint())` there,
and a heavy process is on another thread with the calling code unchanged
(`examples/worker`).

The format is documented for other languages in `packages/wire/spec/`. Its JSON
vectors define the contract and also run in this repository's CI.
`@nonchalant/host` puts it on real WebSockets; each connection is its own
session and cleans up after itself. This interface similarity does not erase
network constraints: wire values are JSON, requests can fail, and access must
be authorized at the host and inside application processes. See
[Hosting safely](hosting.md).

## What updates cost, measured

The structural diff is the heart of the write path, so its costs are worth
knowing (measured on Node v22.12, a 10k-item list of small objects; the
1-of-10k case is also the CI budget):

| situation | cost per yield | verdict |
|---|---|---|
| immutable update, 1 of 10,000 items changed | ~46 µs | within the repository's frame budget |
| immutable append to 10,000 | ~38 µs | similar cost |
| immutable update, 1 of 100,000 | ~760 µs | reasonable for occasional interaction; measure frame loops |
| zero structural sharing, 10,000 items (mutate-and-clone) | ~4,900 µs | reuse unchanged objects to avoid this case |
| small state (a form, a game HUD), even with zero sharing | ~4 µs | unlikely to be the bottleneck |

The practical guidance is to reuse unchanged objects and keep frame-rate
snapshots small. These figures describe one benchmark environment, so measure
your own data shapes when the write path is performance-sensitive.

## The budgets, in one place

| budget | enforced in |
|---|---|
| reconcile: 1 change in 10k ≤ 100 µs | `reconcile.perf.test.ts` |
| Mario: 1 view yield, ≤ 2 DOM writes/frame, 0 node churn | `mario.golden.test.ts` |
| js-framework-benchmark: exact DOM operation counts per operation (swap = 2 moves, clear = one bulk removal) | `bench.test.ts` |
| bundle sizes: core ≤ 8.3 KB gzip, app ≤ 13.7 KB, wire ≤ 9.6 KB, durable ≤ 2.4 KB, inspect ≤ 15 KB | `test/size.test.ts` |
| an idle registry process (a chat room) ≤ 8 KB of heap | `test/room-memory.test.ts` |
| nothing retained after dispose | `process.leaks.test.ts` |
