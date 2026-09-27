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
`self.spawn` starts a child the process owns (see [spawn](#spawn)), and
`self.busy()` returns a hold that keeps a registry from evicting the process
until it is disposed (`using _ = self.busy()` around work that must not be
cut off).
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

Ownership: inside a process body, start children with
`self.spawn(proc, args, opts?)`. It takes the same arguments as `spawn` and
returns the same handle, and the child belongs to this process wherever the
call happens, before or after an `await`. It dies when the process is
disposed, returns, or crashes; a restarted instance starts with no children,
and a child spawned by an instance that has already ended (from a stray
callback, say) is disposed at once. A `finally` that disposal runs can use
`self.spawn` for cleanup work (a flush, a goodbye message), and async
disposal waits for it.

A bare `spawn` inside a body also attaches to the process, but only during
the synchronous part of a step: after an `await` it runs unowned, so moving
it below an `await` changes its lifetime. Use `self.spawn` unless you mean
the child to outlive the process. Registry processes are unowned because
shared state should not end with the caller that happened to start it.

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
paths the diff touched. A process nobody reads skips the diff; there is no
one to wake.

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

## Layers: the primitive and its sugar

Everything above rests on one primitive, an async generator run by `spawn`.
A few exports are shorter ways to write a common case of it. Each one
compiles to the primitive, so the runtime, the registry, the wire, and the
inspector see an ordinary process. Anything written with sugar can be
rewritten by hand without its callers noticing, and all of it is optional.

| sugar | what it stands for | import |
|---|---|---|
| `cell(initial)` | `spawn` of a loop that yields each message it receives, with `initial` | `@nonchalant/core` |
| `reducer(init, reduce)` | the loop-switch-yield process: yield `init(args)`, then yield `reduce(state, msg)` whenever it returns a new state | `@nonchalant/core` |
| `div(attrs, …children)` and the other tags | `h('div', attrs, …children)`; `tagFn(name)` makes one for any tag | `@nonchalant/dom/tags` |

A separate layer holds *wrappers*: functions that take a `Proc` and return a
`Proc`, adding behavior rather than shortening syntax. `durable(proc)` from
`@nonchalant/durable` ([Processes on the server](server.md)) is one, and so
is the undo/redo middleware in `examples/undo-redo`. Because sugar produces a
`Proc` and wrappers accept one, they compose: `durable(reducer(init, reduce))`
is a durable process whose snapshot is its reducer state.

### reducer

Most processes in the examples share one shape: a loop, a `switch` over the
message, and one `yield` after it. `reducer` writes that shape as a function
of the state and the message:

<!-- ts-prelude
import { reducer } from '@nonchalant/core'
import type { Cast, Call, Proc } from '@nonchalant/core'
-->
```ts
type Msg =
  | Cast<{ type: 'add'; by: number }>
  | Call<{ type: 'get' }, number>

// the primitive
const counter: Proc<number, Msg, void> = async function* (self) {
  let n = 0
  yield n
  for await (const msg of self) {
    switch (msg.type) {
      case 'add':
        n += msg.by
        break
      case 'get':
        msg.reply(n)
        continue // no state change, no yield
    }
    yield n
  }
}

// the same process, as sugar
function count(n: number, msg: Msg): number {
  switch (msg.type) {
    case 'add':
      return n + msg.by
    case 'get':
      msg.reply(n)
      return n // the same state: nothing is yielded
  }
}
const counter2 = reducer(() => 0, count)
```

- `init` receives the spawn (or lookup) arguments and runs once per start,
  and again after an `on-crash` restart. Under `durable`, the restored
  snapshot is used instead.
- Returning the state it was given (`===`) means "no change", so nothing is
  yielded. This replaces the choice between `break` and `continue` in the loop.
- A `Call` answers through `msg.reply` before `reduce` returns. A throw is a
  crash, the same as a throw in a generator.
- The process is named after the `reduce` function, which is the name the
  inspector and `onProcessError` report.
- The first yield is `init(args)`, but the type of a read cannot see that:
  pass `initial` to `spawn` or `define` when you want `T` rather than
  `T | undefined`.

`reduce` is synchronous, and its state is also what readers see. Anything
beyond that is a job for the generator:

- awaiting: a fetch, a call to another process, a timer
- more than one yield per message: progress states, or streaming like the
  agent loop's one yield per word
- state readers should not see: a reply parked for a later message, an abort
  controller, a timer handle
- a different way of receiving: `self.latest()`, or a phase with its own loop
- `finally` cleanup, owned children, `self.signal`, `self.cast`

Moving a process from one form to the other rewrites that one definition. Its
message type, its handle, its callers, and any test that drives it through
`channel` stay the same.

### Why layers instead of a second primitive

- **One set of semantics.** Mailbox order, restarts, ownership, call
  rejection, `stale`, the wire, and the inspector are defined once, on the
  generator. Sugar inherits them instead of restating them, so there is no
  second model to learn or to keep consistent.
- **Unused sugar is free.** Core is marked side-effect free, so a bundler
  drops `cell` and `reducer` from an application that never imports them.
- **No migration cliff.** When a reducer needs to await or stream, rewrite
  that one process as a generator. Nothing else changes.
- **Two levels of testing.** The `reduce` function is a plain function you
  can call with a state and a message
  (`examples/shared-cart/shared.test.ts`), and the `Proc` it compiles to
  drives through `channel` like any generator.

Tests: `packages/core/test/reducer.test.ts` (identity skip, calls, restart,
naming, registry), `packages/durable/test/reducer.test.ts` (resuming from a
snapshot), and the reducer cases in `types.check.ts` (per-case reply types).

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
[Performance](performance.md) times the whole update path (diff, readers,
bindings, DOM, and wire) for edits, reorders, fresh snapshots, and streams,
and separates what the budgets below assert from what they don't.

## The budgets, in one place

| budget | enforced in |
|---|---|
| reconcile: 1 change in 10k ≤ 100 µs | `reconcile.perf.test.ts` |
| Mario: 1 view yield, ≤ 2 DOM writes/frame, 0 node churn | `mario.golden.test.ts` |
| js-framework-benchmark: exact DOM operation counts per operation (swap = 2 moves, clear = one bulk removal) | `bench.test.ts` |
| an idle registry process (a chat room) ≤ 8 KB of heap | `test/room-memory.test.ts` |
| nothing retained after dispose | `process.leaks.test.ts` |
