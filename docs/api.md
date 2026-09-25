# API reference

Every public export of every package, with its signature and a line on what it
does. The [concepts](concepts.md) explain the model behind each one; the
links in the right-hand column go there. [Error handling](errors.md) covers
what each piece does when something fails.

Generic parameters follow one convention throughout: `T` is the state a
process yields, `In` its message union, `Args`/`A` its spawn arguments, and
`S` a registry schema (`{ [name]: Definition }`).

## @nonchalant/core

The runtime. No dependencies, no DOM.

### Processes

| export | signature | what it does | concept |
|---|---|---|---|
| `spawn` | `spawn(proc, args, opts?)` → `Process<T \| undefined, In>`; with `opts.initial`, `Process<T, In>` | Runs an async generator as a supervised process. Spawns made during a process's synchronous step belong to it. | [spawn](concepts.md#spawn) |
| `derive` | `derive<T>(fn: () => T)` → `Process<T>` | A memoised computation over other processes. Recomputes when what it read changes; notifies only when its result changes. No mailbox. | [derive](concepts.md#derive) |
| `cell` | `cell<T>(initial: T)` → `Process<T, T>` | Sugar for widget state: a process whose messages are its next values. | [Process](concepts.md#process-from-the-outside) |
| `channel` | `channel<In>(signal?: AbortSignal)` → `Self<In> & Disposable` | A standalone mailbox implementing `Self`, for middleware and for driving a generator in tests. Iteration ends when `signal` aborts or the channel is disposed. | [Self](concepts.md#self-from-the-inside) |
| `mount` | `mount<Out>(sink: Sink<Out>, view: ProcessBase<Out \| undefined> \| Out)` → `Disposable` | Attaches a view to any sink. `@nonchalant/dom` exports a DOM-specific `mount` that most code uses instead. | [Views and sinks](concepts.md#views-and-sinks) |
| `onProcessError` | `onProcessError(handler: (error: unknown, name: string) => void)` → `() => void` | Observes every process crash, including ones a restart recovers from: the thrown value and the generator function's name, a microtask after the crash. One handler at a time; returns its remover. With none installed, a crash shows only on the handle and in rejected calls. | [Error handling](errors.md#processes) |

`SpawnOpts<T>`:

| option | type | default | meaning |
|---|---|---|---|
| `initial` | `T` | none | First readable value; decides `Process<T>` vs `Process<T \| undefined>`. |
| `restart` | `'never' \| 'on-crash'` | `'never'` | `'on-crash'` re-runs the generator from its args after a throw; queued casts replay, pending and queued calls reject. |
| `maxRestarts` | `number` (non-negative integer or `Infinity`) | `3` | Restart budget; past it the crash is terminal. |
| `mailbox` | `number` (non-negative integer) | unbounded | Queue bound; overflow drops the oldest message (a dropped call rejects) with a one-time warning. |
| `quiet` | `boolean` | `false` | The process's crashes are expected and surfaced elsewhere (as `stale` and rejected calls), so `onProcessError` skips them. The wire client's remote refs use it: a disconnect is not a bug. |

### The Process face

| member | type | what it does |
|---|---|---|
| `p()` | `T` | The latest yield. Subscribes by path inside a tracked context; a plain snapshot elsewhere. |
| `p.cast(msg)` | `(msg: Casts<In>) => void` | Fire-and-forget. Present only when `In` has `Cast` members. |
| `p.call(msg)` | `(msg: Req) => Promise<Res>` | Request/response. Present only when `In` has `Call` members. Rejects on crash, finish, or dispose; a call rejected by a crash never runs in a restarted instance. |
| `p.pending` | `boolean` | Working toward its next yield. |
| `p.stale` | `boolean` | The value survived a crash, a disposal, or a lost connection. |
| `p.error` | `unknown` | The last failure, if any. |
| `p[Symbol.asyncIterator]()` | `AsyncIterator<T>` | A lossy latest-value stream; each iterator is its own subscription. It ends when the process returns, crashes terminally, or is disposed. |
| `p[Symbol.dispose]()` | `void` | Starts teardown; does not wait for async `finally` work. |
| `p[Symbol.asyncDispose]()` | `Promise<void>` | Starts teardown and resolves when this process and its owned children have settled. |

### Reactive graph

| export | signature | what it does | concept |
|---|---|---|---|
| `effect` | `effect(fn: () => void \| (() => void))` → `() => void` | Runs `fn` now and whenever what it read changes. A returned function is its cleanup, run before each re-run and on stop. Returns the stop function. | [effect](concepts.md#effect-and-untracked) |
| `untracked` | `untracked<T>(fn: () => T)` → `T` | Runs `fn` without recording reads. | [effect](concepts.md#effect-and-untracked) |
| `flush` | `flush()` → `void` | Runs queued effects now instead of on the next microtask. Rethrows the first effect error after running the rest. | [The graph](concepts.md#the-graph-why-updates-are-exact) |

### Registry

| export | signature | what it does | concept |
|---|---|---|---|
| `define` | `define(proc, opts?: DefineOpts<T>)` → `Definition<T, In, A>`; with `opts.initial`, `Definition<T, In, A, never>` | A schema entry: the generator a name resolves to, plus spawn options and `evict`. | [Registry](concepts.md#registry) |
| `registry` | `registry<S>(defs: S, opts?: RegistryOpts)` → `RegistryHandle<S>` | A local registry over a typed schema. | [Registry](concepts.md#registry) |
| `RegistryHandle.lookup` | `lookup(name, args?)` → `ProcessOf<S[name]>` | Get-or-spawn by name plus arguments (argument key order ignored). Reads are `T \| undefined` unless the definition has `initial`. Throws for a name not in the schema. | [Registry](concepts.md#registry) |
| `RegistryHandle.evict` | `evict(name, args?)` → `void` | Disposes and forgets one entry, or every entry under the name. | [Registry](concepts.md#registry) |

`DefineOpts<T>` is `SpawnOpts<T>` plus `evict?: number`: milliseconds to keep an
unwatched process alive (finite, non-negative; omit to never auto-evict).

`RegistryOpts` is `{ maxEntries?: number }` (positive; omit for no cap). Past
the cap, the least recently looked-up *unwatched* entries are disposed.
Watched entries, and entries holding unanswered calls, are never evicted, so a registry whose every entry is watched
can sit above the cap until watchers leave. A watcher is an effect, or a
derive or iterator an effect reads through; a derive read only as a snapshot
does not keep an entry alive.

### Diff and patch

| export | signature | what it does | concept |
|---|---|---|---|
| `reconcile` | `reconcile(prev: Json, next: Json)` → `Patch` | The structural diff every yield goes through: ops on RFC 6901 paths. A record key whose value is `undefined` counts as absent. | [The graph](concepts.md#the-graph-why-updates-are-exact) |
| `applyPatch` | `applyPatch(doc: Json, patch: Patch)` → `Json` | Applies a patch without mutating `doc`. Throws on a malformed path, a non-canonical array index (RFC 6901: digits, no leading zero), or an out-of-range splice. | [Wire](concepts.md#wire) |

### Types

| type | what it is |
|---|---|
| `Cast<Msg>` | A one-way message: `Msg & { reply?: never }`. |
| `Call<Req, Res>` | A message that expects an answer: `Req & { reply: (res: Res) => void }`. |
| `Casts<In>` / `Calls<In>` | The cast / call members of a message union. |
| `Res<M>` | The reply type of a call member. |
| `Process<T, In>` | The outside face: `ProcessBase<T>` plus `cast` and `call` where `In` allows them. |
| `ProcessBase<T>` | Read, `pending`, `stale`, `error`, iteration, and disposal. |
| `Self<In>` | The inside face: an `AsyncIterable<In>` mailbox, `signal`, `latest()`, `cast`. |
| `Proc<T, In, Args>` | `(self: Self<In>, args: Args) => AsyncGenerator<T, unknown, undefined>`: what `spawn` runs. A return value is not a `T`, so driving one by hand needs a `done` check before reading `next().value`. |
| `Definition<T, In, Args, Before = undefined>` | A phantom-typed schema entry. `Before` is what a read returns ahead of the first yield: `undefined`, or `never` when `define` got `initial`. |
| `Schema` | `{ [name: string]: Definition<unknown, unknown, unknown> }`. |
| `Registry<S>` | Anything with a typed `lookup`: a local registry or a `connect()` connection. |
| `ProcessOf<D>` / `ArgsOf<D>` | The process and argument types a definition resolves to. |
| `RegistryHandle<S>`, `RegistryOpts`, `DefineOpts<T>`, `SpawnOpts<T>` | See above. |
| `VNode` | `{ tag, ns?, attrs, children }`: a view node as plain data. |
| `Slot` | What a child position accepts: primitives, `VNode`, thunks, processes, promises, async iterables, arrays of slots. |
| `Sink<Out>` | A render target: `{ mount(view): Disposable }`. |
| `Json`, `Op`, `Patch` | JSON values, and the `set` / `del` / `splice` patch ops. |

## @nonchalant/dom

Views as plain data, and the DOM sink.

| export | signature | what it does | concept |
|---|---|---|---|
| `mount` | `mount(container: Element, view: View)` → `Disposable` | Renders a `VNode`, a thunk, or a view process into `container`. Disposal unbinds every binding beneath. | [Views and sinks](concepts.md#views-and-sinks) |
| `domSink` | `domSink(container: Element)` → `Sink<VNode>` | The DOM sink for core's generic `mount(sink, view)`. | [Views and sinks](concepts.md#views-and-sinks) |
| `h` | `h<K extends string>(tag: K, attrs?: AttrsFor<K>, ...children: Slot[])` → `VNode` | The generic constructor, for SVG, MathML, custom elements, or any tag without a named export. | [Views and sinks](concepts.md#views-and-sinks) |
| `tagFn` | `tagFn<K extends string>(tag: K)` → `TagFn<K>` | Makes a named constructor like the ones in `/tags`. | |
| `onRenderError` | `onRenderError(handler: RenderErrorHandler)` → `() => void` | Routes render failure reports (a throwing binding, a rejected slot promise) away from `console.error`. Returns a restore function. | [Error handling](errors.md#rendering) |
| `Attrs` | type | Untyped attributes: `key`, `exit`, `ns`, and any other name as a static value, an `on*` listener function, or a binding. What the sink reads, and the escape hatch. | |
| `AttrsFor<K>` | type | The attributes for tag name `K`: `HtmlAttrs` for an HTML tag, `SvgAttrs` for an SVG tag, `Attrs` for anything else or for `K = string`. | |
| `HtmlAttrs<E, M>` | type | An HTML element's writable attribute-backed properties (under their attribute names: `for`, `tabindex`, `colspan`), `data-*`, `aria-*`, and lowercase `on*` listeners typed from its event map. | |
| `SvgAttrs<E>` | type | Typed lowercase `on*` listeners; every other name is unchecked `Attrs`. | |
| `TagFn<K>` | type | `(attrs?: AttrsFor<K>, ...children: Slot[]) => VNode`. | |
| `View` | type | `VNode \| ProcessBase<VNode \| undefined> \| (() => VNode \| null \| undefined)`. | |
| `RenderErrorHandler` | type | `(what: string, error: unknown) => void`. | |

**Attributes.** `false` and `null` remove an attribute, `true` sets it empty,
anything else is stringified; `aria-*` renders booleans as `"true"`/`"false"`.
`value`, `checked`, and `selected` are set as properties, after the element's
children exist, so a `<select value>` can match an option declared inside it.
Text and attribute values are never parsed as HTML.

**URL and handler policy.** Two attribute-level injection routes are closed in
the sink:

- A `javascript:` URL in `href`, `src`, `action`, `formaction`, or
  `xlink:href` is removed instead of set. The scheme is tested after stripping
  U+0000–U+0020 (the characters browsers ignore there), so `' java	script:'`
  is caught too. Other schemes, `data:` included, pass: treat user-supplied
  URLs as untrusted and allow-list them yourself.
- An `on*` attribute takes only a function. Any other value (a string of
  script, say) sets no attribute and no listener, and warns once in the
  console.

Both are enforced by the "attribute-level injection" tests in
`packages/dom/test/render.test.ts`. Console warnings, once per distinct
message, also flag camelCase listeners (`onClick` listens for an event named
`Click`, which never fires) and object attribute values.

**Typed attributes.** Named tags and `h('tag', …)` check attributes per
element: `input({ value })` accepts a string, number, or a binding to one;
`div({ onlick })` and `div({ onClick })` are type errors; a listener's
`currentTarget` is the element's own type. SVG listeners are typed, but SVG
attributes (`d`, `fill`, `viewBox`) are not in the DOM lib, so they are
unchecked. For a name the DOM lib does not know, widen the tag:
`h(tag as string, attrs)` takes plain `Attrs`. The negative cases live in
`packages/dom/test/attrs.check.ts`.

**`@nonchalant/dom/tags`** exports one `TagFn` per HTML element: `html head body
title header footer main nav section article aside h1`–`h6 div p ul ol li dl dt
dd pre blockquote figure figcaption hr span a em strong small code kbd samp sub
sup i b u mark time br wbr var_ img picture video audio source track canvas
iframe embed object table caption colgroup col thead tbody tfoot tr td th form
fieldset legend label input button select optgroup option textarea output
progress meter datalist details summary dialog menu template slot noscript`.
`var_` is `<var>` (a reserved word); anything else goes through `h`.

## @nonchalant/wire

The protocol, its codec, transports, and both ends of a connection. Isomorphic.

| export | signature | what it does | concept |
|---|---|---|---|
| `connect` | `connect<S>(transport: Transport)` → `Connection<S>` | A registry whose lookups are served by the other end. Remote processes have the full Process face; `close()` tears it down. Casts made while disconnected queue per ref (the newest 64) and are sent after the re-lookup; calls made while disconnected reject at once. A call's reply is not ordered against the process's yields. | [Wire](concepts.md#wire) |
| `expose` | `expose(reg: Exposable, transport: Transport, opts?: ExposeOpts)` → `() => void` | Serves a registry, or any `Exposable` gateway, over a transport. Returns a disposer that releases every watch. | [Wire](concepts.md#wire) |
| `WireError` | `class WireError extends Error { detail: Json }` | What remote failures reject and throw with. `detail` is the JSON the host sent. | [Error handling](errors.md#the-wire) |
| `webSocketTransport` | `webSocketTransport(url, opts?: { retryDelay? })` → `Transport & { close() }` | A reconnecting WebSocket client. Redials with exponential backoff (base 500 ms, up to 8×, jittered to 50–100%). | [Wire](concepts.md#wire) |
| `portTransport` | `portTransport(port: MessageEndpoint)` → `Transport` | A transport over a `Worker`, `MessagePort`, or `worker_threads` port. | [Wire](concepts.md#wire) |
| `workerEndpoint` | `workerEndpoint()` → `MessageEndpoint` | Inside a browser worker, the global scope as a port back to the page. | [Wire](concepts.md#wire) |
| `broadcastChannelTransport` | `broadcastChannelTransport(name)` → `Transport & { close(); announce() }` | A bus between tabs. The hosting tab calls `announce()` once it serves. | [Wire](concepts.md#wire) |
| `memoryPair` | `memoryPair()` → `MemoryLink` | An in-memory client/host pair with `disconnect()`, `reconnect()`, and `settle()`, for tests. | [Testing](testing.md) |
| `encode` | `encode(msg: ClientMsg \| HostMsg)` → `string` | Serializes a protocol message. | [Protocol](PROTOCOL.md) |
| `PROTOCOL` | `3` | The protocol revision. Every lookup carries it as `v`; a host answers a lookup with a different `v` with a raise. `GET /schema` on `@nonchalant/host` reports it too. | [Protocol](PROTOCOL.md) |
| `decodeClient` / `decodeHost` | `(data: string)` → `ClientMsg \| null` / `HostMsg \| null` | Validates and decodes one direction; `null` for garbage or the wrong direction. | [Protocol](PROTOCOL.md) |

| type | what it is |
|---|---|
| `Transport` | `{ send(data: string): void; subscribe(handlers): () => void }` |
| `TransportHandlers` | `{ message(data: string): void; open?(): void; close?(): void }` |
| `MemoryLink` | `{ client, host, disconnect(), reconnect(), settle() }` |
| `MessageEndpoint` | `{ postMessage(data), addEventListener('message', fn), start?() }` |
| `WebSocketTransportOpts` | `{ retryDelay?: number }` |
| `Connection<S>` | `Registry<S> & { close(): void }` |
| `Exposable` | The gateway `expose` serves: `lookup(name: string, ...args: unknown[]): unknown`, plus two optional members below. A registry is one. |
| `ExposeOpts` | `{ maxWatches?: number; lookupRate?: { max: number; perMs: number } }`, below. |
| `ClientMsg` / `HostMsg` | The eight protocol ops: `lookup cast call exit` / `yield reply done raise`. |

`Exposable` members:

| member | type | meaning |
|---|---|---|
| `lookup` | `(name: string, ...args: unknown[]) => unknown` | Resolves a client lookup. Throwing answers the lookup with a raise. |
| `admit?` | `(name: string, msg: { type: string } & { [key: string]: Json }) => Json \| undefined` | Screens each client message for the process looked up under `name`. Return it, or a replacement (say, with the sender stamped from the session), to deliver it; return `undefined` or throw to refuse it. A refused call rejects; a refused cast is dropped. Runs after the host's own check that the message is an object with a string `type`, which applies with or without `admit`. |
| `principal?` | `string` | Who the session acts for. A string `callId` in a call's message is rewritten into this principal's namespace before delivery, so one client cannot collide with, or read, another's recorded answers by reusing an id. Omit to deliver ids untouched. |

`ExposeOpts`:

| option | default | meaning |
|---|---|---|
| `maxWatches` | no cap | Refs one session may watch at once. A lookup past it raises; a re-lookup on an existing ref is always allowed. |
| `lookupRate` | no cap | `{ max, perMs }`: lookups one session may make per fixed window. A lookup past it raises. `@nonchalant/host` sets 100 per 10 s. |

## @nonchalant/durable

Durable processes: a message journal, an effect journal, durable calls, and a
storage port. Isomorphic. [Processes on the server](server.md) is the guide.

| export | signature | what it does |
|---|---|---|
| `durable` | `durable<T extends Json, In extends Json \| DurableCall, Args>(proc: DurableProc<T, In, Args>, opts: DurableOpts<T, Args>)` → `Proc<T, In, Args>` | Wraps a process so each message is journaled before it is handled, and its state, cursor, and call answers are committed together when the process asks for the next one. The result is an ordinary `Proc`. |
| `memoryStore` | `memoryStore(now?: () => number)` → `MemoryStore` | The in-memory `Store` adapter, for tests and demos. `now` (default `Date.now`) stamps committed answers for `prune`. |
| `Fenced` | `class Fenced extends Error` | What a store write rejects with when a later `load` of the same key has claimed it. A durable process that meets it returns quietly and leaves the key to the newer activation. |
| `scheduler` | `scheduler(opts: SchedulerOpts)` → `Scheduler` | Wakes keys whose journaled deadlines (or failed attempts) are due: asks the store's `due` every `interval` and calls `wake(key)` for each, usually a registry lookup. Runs a pass at once; disposable. |
| `storeConformance` | `storeConformance(make: (now: () => number) => ConformanceStore \| Promise<ConformanceStore>, t: ConformanceTest)` → `void` | From `@nonchalant/durable/conformance`. Registers the `Store` contract as tests through the runner's own `describe`/`it`/`expect`; `make` returns an empty store stamping answers with `now`. |

| type | what it is |
|---|---|
| `DurableProc<T, In, Args>` | `(self: Self<In>, args: Args, durable: Durable<T>) => AsyncGenerator<T>` |
| `Durable<T>` | `restored: T \| undefined` (the last committed state, migrated); `step(name, fn: (idempotencyKey: string) => R \| Promise<R>)` (an effect recorded exactly once; `fn` gets `${key}#${seq}#${index}`, stable across replays); `call(name, invoke: (callId: string) => Promise<R>)` (a call with a replay-stable id); `sleep(name, ms)` (a journaled deadline, which also makes the key due for a `scheduler`). |
| `DurableOpts<T, Args>` | Below. |
| `DurableCall` | `{ readonly callId: string; readonly reply: (res: never) => void }`: a call a durable process accepts carries its own id. |
| `Store` | The storage port, eight methods, below. |
| `Loaded` | `{ snapshot: Json \| undefined; version: number; cursor: number; epoch: number }`: what `load` returns. |
| `Logged` | `{ seq: number; msg: Json; callId?: string }`: one journaled message. |
| `StepRecord` | `{ index: number; name: string; result: Json }`: one recorded effect; negative indices record failed attempts. |
| `Commit` | `{ snapshot: Json \| undefined; version: number; cursor: number; results: [string, Json][]; dead?: DeadLetter }`: one message's acknowledgement. |
| `DeadLetter` | `Logged & { error: string }`: a message given up on, with its last failure. |
| `MemoryStore` | `Store & { keys(): number; dead(key): DeadLetter[]; prune(before: number): void }`: a key count for reclamation tests, a key's dead letters, and a retention sweep that forgets answers committed before `before`. |
| `Scheduler` | `Disposable & { tick(): Promise<string[]> }`: `tick` runs one pass now and resolves with the keys it woke; disposing stops the passes. |
| `SchedulerOpts` | Below. |
| `ConformanceStore` | `Store & { dead(key): DeadLetter[] \| Promise<…>; prune(before: number): void \| Promise<void> }`: what the conformance suite needs beyond the port. |
| `ConformanceTest` | `{ describe, it, expect }`: the subset of a test runner the suite calls (`expect(x).toBe`, `.toStrictEqual`). |

`DurableOpts<T, Args>`:

| option | default | meaning |
|---|---|---|
| `store` | required | The `Store` adapter. |
| `key` | required | `(args: Args) => string`: the storage identity of an instance, usually from its lookup args. |
| `now` | `Date.now` | Wall clock for `sleep` and the wake times it records; injected so tests do not wait. |
| `version` | `0` | The snapshot schema version this code writes. |
| `migrate` | none | `(old: Json, from: number) => T`: brings a snapshot committed under another version up to date. Required once `version` moves. |
| `maxAttempts` | no limit | How many times one message may crash the process before it is dead-lettered and the cursor steps past it. |
| `onPoison` | none | `(key: string, dead: DeadLetter) => void`: told after a message is dead-lettered. |

`SchedulerOpts`:

| option | default | meaning |
|---|---|---|
| `store` | required | The `Store` whose wake times it reads. |
| `wake` | required | `(key: string) => unknown`: activate one due key, e.g. `(id) => reg.lookup('order', { id })`. |
| `interval` | `1000` | Milliseconds between passes; the next pass is scheduled after the last one ends. |
| `lease` | `30_000` | How long a woken key stays hidden from other passes, on any scheduler, before it may be woken again. |
| `limit` | `100` | Keys fetched per `due` call; a pass keeps fetching until it gets fewer. At least 1. |
| `now` | `Date.now` | The clock wake times are compared against; the same one the durable processes use. |
| `onError` | `console.error` | Told when a pass or a `wake` throws. The pass goes on. |

`Store` methods. Every write carries the epoch `load` handed out and must
change nothing and reject with `Fenced` if the key has been claimed since;
`commit` is one transaction.

| method | signature | job |
|---|---|---|
| `load` | `(key) => Promise<Loaded>` | Claim the key (raise its epoch) and return the acknowledged state. |
| `append` | `(key, epoch, msg: Json, callId?) => Promise<number>` | Journal an inbound message before it is handled; returns its sequence number. |
| `pending` | `(key, cursor) => Promise<Logged[]>` | Messages after `cursor`, in order: what a restart replays. |
| `putStep` | `(key, epoch, seq, index, name, result: Json, wakeAt?: number) => Promise<void>` | Record one completed effect, or a failed attempt, of message `seq`. With `wakeAt`, the key is also due at that time, replacing any earlier wake. |
| `steps` | `(key, seq) => Promise<StepRecord[]>` | What is already recorded for that message. |
| `commit` | `(key, epoch, commit: Commit) => Promise<void>` | Acknowledge one message: snapshot, version, cursor, answers, and any dead letter land together or not at all, and the key's wake time is cleared. |
| `result` | `(key, callId) => Promise<Json \| undefined>` | The answer already given to that call, if any. |
| `due` | `(now: number, until: number, limit: number) => Promise<string[]>` | Up to `limit` keys whose wake time is at or before `now`, earliest first; in the same operation each one's wake time moves to `until` (a lease). |

## @nonchalant/react

React hooks over processes. Peer dependencies: `@nonchalant/core` and `react`
18 or later. [Using nonchalant from React](react.md) is the guide.

| export | signature | what it does |
|---|---|---|
| `useProcess` | `useProcess<T>(p: ProcessBase<T>)` → `T` | The current value; re-renders on every yield. Tearing-free (`useSyncExternalStore`). |
| `useDerive` | `useDerive<T>(fn: () => T, deps: DependencyList)` → `T` | `fn` run inside a `derive`: recomputed when a path it read changes, re-rendering only when its result changes. `deps` are the render-scope values `fn` closes over. |
| `useProcessMeta` | `useProcessMeta(p: ProcessBase<unknown>)` → `Meta` | `{ pending, stale, error }`; the object keeps its identity until a field changes. |
| `useSpawn` | `useSpawn(proc, args, opts?)` → `Process<T \| undefined, In>`; with `opts.initial`, `Process<T, In>` | A process owned by the component: spawned on first render, claimed on commit, disposed on unmount. One no commit claims within a second is disposed. `args` and `opts` are read once. |
| `useLookup` | `useLookup<P extends ProcessBase<unknown>>(lookup: () => P)` → `P` | Runs the lookup, keeps the entry watched (safe from idle eviction and the LRU cap) while mounted, and runs it again if the entry is evicted. |
| `Meta` | type | `{ readonly pending: boolean; readonly stale: boolean; readonly error: unknown }` |

## @nonchalant/host

The Node WebSocket host. [Hosting safely](hosting.md) is the guide.

| export | signature | what it does |
|---|---|---|
| `serve` | `serve<S>(defs: S, opts?: ServeOpts<S>)` → `Promise<HostHandle<S>>` | Hosts a registry over WebSockets; resolves once listening. Each connection is its own `expose` session. `GET /schema` serves `{ protocol, names }`. |
| `ServeOpts<S>` | type | See below. |
| `OriginPolicy` | `(origin: string \| undefined, request) => boolean \| Promise<boolean>` | A callback form of `allowedOrigins`. |
| `HostHandle<S>` | `{ registry, port, url, sessions(), close() }` | The running host; `registry` is host-side access to the same processes. |

| option | default | meaning |
|---|---|---|
| `port` | `0` (ephemeral) | TCP port. |
| `path` | `'/'` | WebSocket path. |
| `allowedOrigins` | any origin | Array of origins, or an `OriginPolicy`. An array rejects clients with no `Origin`. |
| `authorize` | allow | Authenticates the schema request and the upgrade. |
| `scope` | the shared registry | `(request, reg) => Exposable \| Promise<Exposable>`: builds the gateway each connection's lookups and messages go through, once per connection, after `authorize`. Throwing rejects the upgrade (500). |
| `maxPayloadBytes` | 1 MiB | Larger client messages close the connection (code 1009). |
| `maxWatchesPerConnection` | no cap | Lookups past it raise to that client. |
| `lookupRate` | `{ max: 100, perMs: 10_000 }` | Lookups per connection per fixed window; one past it raises to that client. |
| `heartbeatMs` | 30 000 (0 disables) | Pings each socket; a missed pong terminates it and releases its watches. |
| `maxBufferedBytes` | 8 MiB | Outbound bytes one socket may have queued before the host terminates it. |

Each connection is a principal: the one its `scope` gateway names, or else a
fresh random one, so call ids are always namespaced per connection. `serve`
throws at once on a negative or non-finite `heartbeatMs`, a non-integer
`maxWatchesPerConnection`, a malformed `lookupRate`, or a non-positive
`maxBufferedBytes`.

## @nonchalant/inspect

The process inspector: a recorder over core's `instrument` hook, time travel,
and a panel. Depends on core and dom. [The inspector](inspect.md) is the
guide.

### The core hook

Exported from `@nonchalant/core`; the inspector is built on it.

| export | signature | what it does |
|---|---|---|
| `instrument` | `instrument(sink: (event: ProcessEvent) => void)` → `() => void` | Reports every process event to `sink`, synchronously, as it happens. One sink at a time; returns its remover. With none installed, each event site costs one check. |
| `ProcessEvent` | type | A union on `type`: `spawn` (parent, name, key, args, state), `cast` (msg), `call` (msg, call), `reply` (call, value), `yield` (ops: the patch from the previous state), `status` (pending, stale, errored), `crash` (error), `restart` (attempt), `exit` (reason: `'done' \| 'crashed' \| 'disposed'`). Every event carries the process `id`. |

### The recorder

| export | signature | what it does |
|---|---|---|
| `inspect` | `inspect(opts?: { size?: number })` → `Inspector` | Installs the sink and records into a ring of `size` entries (default 1000). The inspector's own processes are not recorded. |
| `Inspector` | `{ recording, tree, timeline, stateAt, adopt, [Symbol.dispose] }` | `recording: Process<Recording, RecorderMsg>` owns the data; `tree: Process<TreeNode[]>` and `timeline: Process<Entry[]>` derive from it; `stateAt(id, seq)` reconstructs a state; `adopt(fn)` marks what `fn` spawns as the inspector's own. Disposing stops recording. |
| `Recording` | `{ size, seq, events: Entry[], procs: { [id]: ProcNode } }` | The recorded data, all plain JSON. |
| `Entry` | type | One timeline row: a `ProcessEvent` other than `status`, summarized to JSON, plus its `seq`. |
| `ProcNode` | type | One recorded process: id, parent, name, key, status, the three flags, its current `state`, and the `base`/`baseSeq` time travel starts from. |
| `stateAt` | `stateAt(rec: Recording, id: number, seq: number)` → `Json \| null \| undefined` | A process's state just after event `seq`: `base` plus every retained yield patch up to `seq`. `undefined` if the process is unknown or `seq` is older than the ring retains. |
| `record` | `record(rec: Recording, d: Draft)` → `Recording` | The recorder's reducer: fold one event in, trimming the ring. |
| `clear` | `clear(rec: Recording)` → `Recording` | Drop every entry and every ended process. |
| `tree` | `tree(procs)` → `TreeNode[]` | Processes not yet disposed, nested by ownership. |
| `summarize` | `summarize(value: unknown)` → `Json` | Plain JSON by reference; anything else as a bracketed label. |
| `draft` | `draft(e: ProcessEvent)` → `Draft` | An event with its live values summarized. |

### The panel

| export | signature | what it does |
|---|---|---|
| `mountInspector` | `mountInspector(el: Element, inspector?: Inspector)` → `Disposable & { inspector }` | Renders the tree, the timeline and the detail pane into `el`. Starts an inspector unless given one, and disposes the one it started. |
