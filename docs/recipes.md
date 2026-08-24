# Recipes

These recipes build common patterns from the public primitives. Most have a
runnable version in `examples/`.

## Widget state with `cell`

```ts
function cell<T>(initial: T): Process<T, T> {
  return spawn<T, T, void>(async function* (self) {
    for await (const next of self) yield next
  }, undefined, { initial })
}
```

`cell` is a convenience wrapper for this common pattern. A cell created inside
a view belongs to that view and is disposed with it. See `examples/counter`.

## Typeahead with the latest queued input

`self.latest()` reads the mailbox in "skip to newest" mode: while a search is
in flight the loop isn't listening, and when it comes back it picks up the
most recent query, ignoring everything in between. `self.signal` cancels the
in-flight request if the process is disposed.

```ts
for await (const { q } of self.latest()) {
  yield { q, results, pending: true }
  try {
    results = await api.search(q, { signal: self.signal })
    yield { q, results, pending: false }
  } catch { /* aborted or failed; keep going */ }
}
```

This prevents a backlog, but it does not cancel the request already in flight.
That request completes and publishes its yield before the newest queued
query begins, which is why each yield carries its own `q`. If even a transient
stale result matters, don't await in the loop: stamp each request with an
epoch, run it in the background, `self.send` the result back, and ignore
results whose epoch is old. `examples/typeahead`.

## Forms that wait for a result

Make the submit a `Call` message. The form gets a typed promise for its own
result instead of watching status fields go by. `examples/form`.

## A small query cache

```ts
const users = registry({
  user: define(async function* (self, { id }: { id: number }) {
    yield await fetchUser(id)
    for await (const _ of self) void _      // stay alive while anyone watches
  }, { evict: 30_000 }),
})
users.lookup('user', { id: 1 })   // deduped by key, shared, evicted when idle
```

Lookups with the same key share one fetch. The entry is removed 30 seconds
after its last watcher leaves, and the next lookup starts a new fetch.
`packages/core/test/registry.test.ts` verifies this lifecycle.

`examples/query` adds loading and error states, retries, stale-while-refetch,
and mutations implemented as `ask()` calls on the query. The example uses
write-through updates instead of an invalidation graph, with the schema
tested headlessly in `examples/query/shop.test.ts` and the reasoning written
up right on the demo page.

## Routing with a URL process

The current route is state like any other, and pages can be view processes:
the router iterates the route, disposes the outgoing page (tearing down its
whole scope), yields a loading state, `await import()`s the chunk, and yields
the new page. Navigation, loading states, code splitting, and teardown in a
small amount of process code. The router includes the route process,
`navigate`, and spreadable `link()` attributes that replace history by default.
It is defined in `examples/lib/router.ts` and used by `examples/router`. It
ships in two flavors, `hashRouter` and `historyRouter` (real paths via
pushState/popstate; needs history-fallback hosting).

## Undo and redo by wrapping a process

A process is a function, so middleware is function composition: wrap a proc,
give the inner one a private `channel`, keep the history in the wrapper. The
same shape gives you logging, persistence, and replay. `examples/undo-redo`;
a variant that groups a whole slider drag into one undo step is in
`examples/7guis/circle-drawer.ts`.

## A process for a drag gesture

Start a process on pointerdown, yield offsets while the pointer moves, and
dispose it on pointerup. Disposal also removes the gesture's subscriptions.

```ts
el.addEventListener('pointerdown', (down: PointerEvent) => {
  const gesture = spawn(async function* (self: Self<PointerEvent>) {
    for await (const move of self)
      yield { dx: move.clientX - down.clientX, dy: move.clientY - down.clientY }
  }, undefined)
  const stop = effect(() => { const o = gesture(); if (o) applyOffset(o) })
  const onMove = (e: PointerEvent): void => gesture.send(e)
  const onUp = (): void => {
    removeEventListener('pointermove', onMove)
    removeEventListener('pointerup', onUp)
    stop()
    gesture[Symbol.dispose]()
  }
  addEventListener('pointermove', onMove)
  addEventListener('pointerup', onUp)
})
```

Runnable version, with a draggable box: `examples/drag`.

## A spreadsheet built from derives

Give every cell a derive that parses its formula and reads the cells it
references. Dependency tracking is automatic: edit A1 and only
formulas that (indirectly) mention A1 recompute; a formula whose result didn't
change wakes nobody downstream; a reference cycle comes back as `#CYCLE`
instead of a hang. `examples/7guis/cells.ts`, with the test to prove each of
those claims.

## Using the wire between tabs

One tab wins a Web Lock and hosts over a `BroadcastChannel` transport; every
tab connects as a client. When the hosting tab closes, another tab acquires the
lock and takes over. The protocol requires a transport, not a server.
`examples/multi-tab`.

## Using the wire with a Web Worker

A transport carries ordered, reliable strings; the port to a worker is one. The
worker calls `expose(registry({...}), portTransport(workerEndpoint()))`, the tab
calls `connect(portTransport(new Worker(...)))`, and a heavy process runs off
the thread that draws while its state arrives as data patches. `portTransport`
takes a port rather than making one, so a `MessagePort` or worker_threads'
`parentPort` works the same way, and it needs no reconnect story: a port does
not drop.

Two things to keep in mind when a process grinds on its own:

- Chunk the work and drive the next chunk with a **timer**, not a bare
  `self.send`. A mailbox loop that re-sends synchronously resolves in
  microtasks, and the event loop never turns again, so nothing else is heard.
- Yield the small thing. Keep the working set in the process (a plain local
  array) and let `ask()` fetch it when someone actually wants it; every yield
  is a diff that has to cross.

`examples/worker`.

## Brokers behind a port

A bus and work queue can each be defined as an interface with an adapter. A
subscription process subscribes during setup and unsubscribes on disposal.
Looking it up by topic allows the registry to cache one subscription per topic.
A queue worker reserves a job under a lease, handles it, and acknowledges it.
If the worker dies, the lease expires and another worker can receive the job.
See `examples/messaging` and [Processes on the server](server.md).

## Where are the operators?

Nonchalant does not define a large operator API. Common RxJS and FRP operations
map to the existing primitives:

| operator | here |
|---|---|
| `map` / `filter` / `scan` over values | `derive(() => f(p()))` or code in the process loop |
| `combineLatest` | one derive reading several processes |
| `fold` / reducers | the `for await` loop *is* the fold |
| queued-input conflation | `self.latest()` |
| `startWith` | `initial` |
| retry / error channels | `restart` policies, `stale`, `error` |

Most of these mappings are short enough to keep near the code that uses them.
Two patterns that carry more lifecycle logic are shown below:

```ts
// merge: pump several processes into one mailbox
function merge<T>(...sources: Process<T>[]): Process<T | undefined, T> {
  return spawn<T, T, void>(async function* (self) {
    for (const s of sources)
      void (async () => {
        for await (const v of s) {
          if (self.signal.aborted) break
          self.send(v)
        }
      })()
    for await (const v of self) yield v
  }, undefined)
}

// debounce: yield ms after the source goes quiet
function debounced<T>(source: Process<T>, ms: number): Process<T | undefined> {
  return spawn<T, never, void>(async function* (self) {
    const settled = channel<T>(self.signal)
    let timer: ReturnType<typeof setTimeout> | undefined
    void (async () => {
      for await (const v of source) {
        if (self.signal.aborted) break
        clearTimeout(timer)
        timer = setTimeout(() => settled.send(v), ms)
      }
    })()
    for await (const v of settled) yield v
  }, undefined)
}
```

A pump loop notices disposal when the source next produces a value. This is
usually sufficient for UI streams. If a source may remain silent indefinitely,
call `it.return()` from an abort listener.

## A chat room over the wire

A room is a process that reduces posts into a capped history. Host it with
`serve`, look it up by name from every tab, and the whole client-server chat
uses the same process code as local state. Posts are casts, history
arrives as patches, a dead server shows as `stale: true` until the
reconnecting transport finds it again. `examples/chat`.

## Switching a registry to a remote host

Replace a local registry with `connect(webSocketTransport(url))` when the
callers only depend on the registry interface. The process and view can stay
the same, but deployment adds JSON boundaries, latency, disconnection,
authentication, and authorization. `examples/shared-cart` shows the code
change; [Hosting safely](hosting.md) covers the operational boundary.

## Durable processes with loading, checkpoints, and eviction

Process state lives in generator locals, so durability is a contract you
write, not a feature you enable: load before the first yield, checkpoint at
transition boundaries, let eviction deactivate.

```ts
const accounts = registry({
  account: define(async function* (self: Self<AccountMsg>, { id }: { id: string }) {
    let s = (await store.load(id)) ?? initialAccount   // hydrate on activation
    yield s
    for await (const msg of self) {
      s = step(s, msg)                                 // pure reducer
      yield s
      await store.save(id, s)                          // checkpoint at the boundary
    }
  }, { evict: 60_000 }),                               // deactivate when idle
})
```

This implements a virtual-actor lifecycle in application code:
`lookup('account', { id })` activates the process, loading hydrates it, and
`evict` deactivates it. The next lookup starts and hydrates it again.
`@nonchalant/durable` adds message and effect journals plus an atomic commit of
state and its cursor; see
[Processes on the server](server.md). Because the mailbox is the single writer,
checkpoints are ordered with no application-level locking; the same shape
gives event sourcing (append the message instead of saving the snapshot,
replay to hydrate). To keep persistence out of the domain code, wrap the proc,
using the same wrapping approach as [undo and redo](#undo-and-redo-by-wrapping-a-process).

The mailbox has a single writer only while one node owns its name. If several
hosts can activate the same ID, the store needs leases or fencing. The library
does not provide that coordination. [Hosting safely](hosting.md)
covers the boundary.

## A deadline on `ask`

A pending remote call already rejects on crash, completion, disconnect, and
dispose. A host handler that never replies can still leave it pending. A
deadline is a race, not a protocol feature:

```ts
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no reply within ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

const receipt = await withDeadline(cart.ask({ type: 'checkout' }), 5_000)
```

## Reading connection status

Connection state uses the existing process metadata. When the transport drops,
each remote handle retains its last value, sets `stale`, and records the error.
A successful re-lookup clears both fields. Because `stale` and `error` are
reactive, a connection indicator can be one derive:

```ts
const status = derive(() => (cart.stale ? 'reconnecting…' : 'live'))
```

Readers of unchanged paths are not notified during reconnection because the
full snapshot is compared with the retained value (`packages/wire/test/wire.test.ts`,
"reconnect is a re-lookup").
