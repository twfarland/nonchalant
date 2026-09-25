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

> TODO(integrator): `onProcessError(handler)` landed from workstream A. Add its
> row here: signature, what it receives, what it returns (a restore function,
> like `onRenderError`?), and the default (console).

`SpawnOpts<T>`:

| option | type | default | meaning |
|---|---|---|---|
| `initial` | `T` | none | First readable value; decides `Process<T>` vs `Process<T \| undefined>`. |
| `restart` | `'never' \| 'on-crash'` | `'never'` | `'on-crash'` re-runs the generator from its args after a throw; queued messages replay, pending calls reject. |
| `maxRestarts` | `number` (non-negative integer or `Infinity`) | `3` | Restart budget; past it the crash is terminal. |
| `mailbox` | `number` (non-negative integer) | unbounded | Queue bound; overflow drops the oldest message (a dropped call rejects) with a one-time warning. |

### The Process face

| member | type | what it does |
|---|---|---|
| `p()` | `T` | The latest yield. Subscribes by path inside a tracked context; a plain snapshot elsewhere. |
| `p.cast(msg)` | `(msg: Casts<In>) => void` | Fire-and-forget. Present only when `In` has `Cast` members. |
| `p.call(msg)` | `(msg: Req) => Promise<Res>` | Request/response. Present only when `In` has `Call` members. Rejects on crash, finish, or dispose. |
| `p.pending` | `boolean` | Working toward its next yield. |
| `p.stale` | `boolean` | The value survived a crash, a disposal, or a lost connection. |
| `p.error` | `unknown` | The last failure, if any. |
| `p[Symbol.asyncIterator]()` | `AsyncIterator<T>` | A lossy latest-value stream; each iterator is its own subscription. |
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
| `define` | `define(proc, opts?: DefineOpts<T>)` → `Definition<T, In, A>` | A schema entry: the generator a name resolves to, plus spawn options and `evict`. | [Registry](concepts.md#registry) |
| `registry` | `registry<S>(defs: S)` → `RegistryHandle<S>` | A local registry over a typed schema. | [Registry](concepts.md#registry) |
| `RegistryHandle.lookup` | `lookup(name, args?)` → `ProcessOf<S[name]>` | Get-or-spawn by name plus arguments (argument key order ignored). Throws for a name not in the schema. | [Registry](concepts.md#registry) |
| `RegistryHandle.evict` | `evict(name, args?)` → `void` | Disposes and forgets one entry, or every entry under the name. | [Registry](concepts.md#registry) |

`DefineOpts<T>` is `SpawnOpts<T>` plus `evict?: number`: milliseconds to keep an
unwatched process alive (finite, non-negative; omit to never auto-evict).

> TODO(integrator): if a registry-wide option such as `maxEntries` landed, add
> its row here and its failure mode to errors.md.

### Diff and patch

| export | signature | what it does | concept |
|---|---|---|---|
| `reconcile` | `reconcile(prev: Json, next: Json)` → `Patch` | The structural diff every yield goes through: ops on RFC 6901 paths. | [The graph](concepts.md#the-graph-why-updates-are-exact) |
| `applyPatch` | `applyPatch(doc: Json, patch: Patch)` → `Json` | Applies a patch without mutating `doc`. Throws on a malformed path or out-of-range splice. | [Wire](concepts.md#wire) |

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
| `Proc<T, In, Args>` | `(self: Self<In>, args: Args) => AsyncGenerator<T>`: what `spawn` runs. |
| `Definition<T, In, Args>` | A phantom-typed schema entry. |
| `Schema` | `{ [name: string]: Definition<unknown, unknown, unknown> }`. |
| `Registry<S>` | Anything with a typed `lookup`: a local registry or a `connect()` connection. |
| `ProcessOf<D>` / `ArgsOf<D>` | The process and argument types a definition resolves to. |
| `RegistryHandle<S>`, `DefineOpts<T>`, `SpawnOpts<T>` | See above. |
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
| `h` | `h(tag: string, attrs?: Attrs, ...children: Slot[])` → `VNode` | The generic constructor, for SVG, MathML, custom elements, or any tag without a named export. | [Views and sinks](concepts.md#views-and-sinks) |
| `tagFn` | `tagFn(tag: string)` → `TagFn` | Makes a named constructor like the ones in `/tags`. | |
| `onRenderError` | `onRenderError(handler: RenderErrorHandler)` → `() => void` | Routes render failure reports (a throwing binding, a rejected slot promise) away from `console.error`. Returns a restore function. | [Error handling](errors.md#rendering) |
| `Attrs` | type | `key`, `exit`, `ns`, and any other attribute: a static value, an `on*` listener function, or a binding. | |
| `TagFn` | type | `(attrs?: Attrs, ...children: Slot[]) => VNode`. | |
| `View` | type | `VNode \| ProcessBase<VNode \| undefined> \| (() => VNode \| null \| undefined)`. | |
| `RenderErrorHandler` | type | `(what: string, error: unknown) => void`. | |

**Attributes.** `false` and `null` remove an attribute, `true` sets it empty,
anything else is stringified; `aria-*` renders booleans as `"true"`/`"false"`.
`on*` names take functions and become listeners. Text and attribute values are
never parsed as HTML.

> TODO(integrator): the URL policy (blocking `javascript:` URLs, and which
> attributes it covers) and typed attrs landed in another workstream. Describe
> both here; concepts.md and SECURITY.md link to this section for it.

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
| `connect` | `connect<S>(transport: Transport)` → `Connection<S>` | A registry whose lookups are served by the other end. Remote processes have the full Process face; `close()` tears it down. | [Wire](concepts.md#wire) |
| `expose` | `expose(reg: Exposable, transport: Transport, opts?: ExposeOpts)` → `() => void` | Serves a registry, or any `Exposable` gateway, over a transport. Returns a disposer that releases every watch. | [Wire](concepts.md#wire) |
| `WireError` | `class WireError extends Error { detail: Json }` | What remote failures reject and throw with. `detail` is the JSON the host sent. | [Error handling](errors.md#the-wire) |
| `webSocketTransport` | `webSocketTransport(url, opts?: { retryDelay? })` → `Transport & { close() }` | A reconnecting WebSocket client. Redials with exponential backoff (base 500 ms, up to 8×, jittered to 50–100%). | [Wire](concepts.md#wire) |
| `portTransport` | `portTransport(port: MessageEndpoint)` → `Transport` | A transport over a `Worker`, `MessagePort`, or `worker_threads` port. | [Wire](concepts.md#wire) |
| `workerEndpoint` | `workerEndpoint()` → `MessageEndpoint` | Inside a browser worker, the global scope as a port back to the page. | [Wire](concepts.md#wire) |
| `broadcastChannelTransport` | `broadcastChannelTransport(name)` → `Transport & { close(); announce() }` | A bus between tabs. The hosting tab calls `announce()` once it serves. | [Wire](concepts.md#wire) |
| `memoryPair` | `memoryPair()` → `MemoryLink` | An in-memory client/host pair with `disconnect()`, `reconnect()`, and `settle()`, for tests. | [Testing](testing.md) |
| `encode` | `encode(msg: ClientMsg \| HostMsg)` → `string` | Serializes a protocol message. | [Protocol](PROTOCOL.md) |
| `decodeClient` / `decodeHost` | `(data: string)` → `ClientMsg \| null` / `HostMsg \| null` | Validates and decodes one direction; `null` for garbage or the wrong direction. | [Protocol](PROTOCOL.md) |

| type | what it is |
|---|---|
| `Transport` | `{ send(data: string): void; subscribe(handlers): () => void }` |
| `TransportHandlers` | `{ message(data: string): void; open?(): void; close?(): void }` |
| `MemoryLink` | `{ client, host, disconnect(), reconnect(), settle() }` |
| `MessageEndpoint` | `{ postMessage(data), addEventListener('message', fn), start?() }` |
| `WebSocketTransportOpts` | `{ retryDelay?: number }` |
| `Connection<S>` | `Registry<S> & { close(): void }` |
| `Exposable` | `{ lookup(name, ...args): unknown }`: the gateway `expose` serves. |
| `ExposeOpts` | `{ maxWatches?: number }`: caps the refs one session may watch. |
| `ClientMsg` / `HostMsg` | The eight protocol ops: `lookup cast call exit` / `yield reply done raise`. |

Landed from workstream C, not yet reconciled with the source in this branch:

- `PROTOCOL`: the protocol revision constant. Lookups carry `v: 3`, and a host
  answers a lookup with a mismatched version with a raise.
- `Exposable.admit?(name, msg)`: returns the message, a replacement, or
  `undefined` to refuse it. The host only delivers objects with a string
  `type`.
- `Exposable.principal?`: namespaces client call ids, so one session's ids
  cannot collide with another's.
- `ExposeOpts.lookupRate?: { max, perMs }`: a per-session lookup rate limit.
- Casts made while disconnected are queued per ref (the newest 64) and sent on
  reconnect. Replies are not ordered against yields.

> TODO(integrator): confirm each signature above against `packages/wire/src`
> and fold these into the tables.

## @nonchalant/durable

Durable processes: a message journal, an effect journal, durable calls, and a
storage port. Isomorphic. [Processes on the server](server.md) is the guide.

| export | signature | what it does |
|---|---|---|
| `durable` | `durable(proc: DurableProc<T, In, Args>, opts: DurableOpts)` → `Proc<T, In, Args>` | Wraps a process so each message is journaled before it is handled and its state is committed with the cursor after. The result is an ordinary `Proc`. |
| `memoryStore` | `memoryStore()` → `MemoryStore` | The in-memory `Store` adapter, for tests and demos. `keys()` counts stored keys. |

| type | what it is |
|---|---|
| `DurableProc<T, In, Args>` | `(self, args, durable: Durable<T>) => AsyncGenerator<T>` |
| `Durable<T>` | `restored` (last committed state), `step(name, fn)` (an effect run at most once), `call(name, invoke)` (a call with a replay-stable id), `sleep(name, ms)` (a journaled deadline). |
| `DurableOpts` | `{ store: Store; key: (args) => string; now?: () => number }` |
| `DurableCall` | A call a durable process accepts: it carries its own `callId`. |
| `Store` | The storage port: `load append pending putStep steps commit result putResult`. `commit` must write snapshot and cursor together or not at all. |
| `Loaded`, `Logged`, `StepRecord` | The records `Store` methods pass. |
| `MemoryStore` | `Store & { keys(): number }` |

Landed from workstream D, not yet reconciled with the source in this branch:

- `DurableOpts<T, Args>` gains a type parameter and the options `version`,
  `migrate(old, from)`, `maxAttempts`, and `onPoison(key, dead)`.
- New exports `Fenced`, `Commit`, and `DeadLetter`.
- The `Store` port has seven methods.
- `memoryStore(now?)`, with `dead(key)` and `prune(before)`.
- `step`'s `fn` receives a stable idempotency key, `${key}#${seq}#${index}`.

> TODO(integrator): rewrite the durable tables above from the landed source.

## @nonchalant/host

The Node WebSocket host. [Hosting safely](hosting.md) is the guide.

| export | signature | what it does |
|---|---|---|
| `serve` | `serve<S>(defs: S, opts?: ServeOpts<S>)` → `Promise<HostHandle<S>>` | Hosts a registry over WebSockets; resolves once listening. Each connection is its own `expose` session. `GET /schema` serves the name list. |
| `ServeOpts<S>` | type | See below. |
| `OriginPolicy` | `(origin: string \| undefined, request) => boolean \| Promise<boolean>` | A callback form of `allowedOrigins`. |
| `HostHandle<S>` | `{ registry, port, url, sessions(), close() }` | The running host; `registry` is host-side access to the same processes. |

| option | default | meaning |
|---|---|---|
| `port` | `0` (ephemeral) | TCP port. |
| `path` | `'/'` | WebSocket path. |
| `allowedOrigins` | any origin | Array of origins, or an `OriginPolicy`. An array rejects clients with no `Origin`. |
| `authorize` | allow | Authenticates the schema request and the upgrade. |
| `scope` | the shared registry | Builds the `Exposable` each connection's lookups go through. Throwing rejects the upgrade (500). |
| `maxPayloadBytes` | 1 MiB | Larger client messages close the connection (code 1009). |
| `maxWatchesPerConnection` | no cap | Lookups past it raise to that client. |
| `heartbeatMs` | 30 000 (0 disables)\* | Pings each socket; a missed pong terminates it and releases its watches. |
| `maxBufferedBytes` | 8 MiB\* | Output buffered for one slow client before it is dropped. |
| lookup rate | 100 per 10 s\* | Per-connection lookup limit (`ExposeOpts.lookupRate`). |

\* Landed from workstream C; the source in this branch predates it.

> TODO(integrator): confirm the starred defaults and option names against
> `packages/host/src/index.ts`.
