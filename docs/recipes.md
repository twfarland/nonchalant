# Recipes

Common patterns, each a few lines over the primitives — no special APIs, no
privileged access. Most exist as runnable code in `examples/`.

## Widget state — `cell`

```ts
function cell<T>(initial: T): Process<T, T> {
  return spawn<T, T, void>(async function* (self) {
    for await (const next of self) yield next
  }, undefined, { initial })
}
```

Five lines, shipped as sugar because everyone needs it. A cell created inside
a view belongs to that view and disappears with it. `examples/counter`.

## Typeahead — cancel the stale, keep the latest

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

That's the entire debounce/race/cancel story. `examples/typeahead`.

## Forms — ask for the outcome

Make the submit a `Call` message. The form gets a typed promise for its own
result instead of watching status fields go by. `examples/form`.

## A query cache — twenty lines of registry

```ts
const users = registry({
  user: define(async function* (self, { id }: { id: number }) {
    yield await fetchUser(id)
    for await (const _ of self) void _      // stay alive while anyone watches
  }, { evict: 30_000 }),
})
users.lookup('user', { id: 1 })   // deduped by key, shared, evicted when idle
```

Same key → same fetch, shared by everyone. Last watcher leaves → 30 seconds →
gone. Next lookup → fresh fetch. That's the useful core of a query library,
and it's a passing test: `packages/core/test/registry.test.ts`.

The full construct — loading and error states, retry, stale-while-refetch,
prefix invalidation, and mutations as `ask()` — is `examples/lib/query.ts`
(about eighty lines), running in `examples/query`.

## Routing — the URL is a process

The current route is state like any other, and pages can be view processes:
the router iterates the route, disposes the outgoing page (tearing down its
whole scope), yields a loading state, `await import()`s the chunk, and yields
the new page. Navigation, loading states, code splitting, and teardown in a
dozen lines of ordinary code. The router itself — route process, `navigate`,
spreadable `link()` attrs that replace history by default — is a forty-line
userland construct: `examples/lib/router.ts`, used by `examples/router`.

## Undo/redo — wrap the process

A process is a function, so middleware is function composition: wrap a proc,
give the inner one a private `channel`, keep the history in the wrapper. The
same shape gives you logging, persistence, and replay. `examples/undo-redo`;
a variant that groups a whole slider drag into one undo step is in
`examples/7guis/circle-drawer.ts`.

## Drag — a gesture with a lifetime

Spawn a process on pointerdown; it yields offsets; dispose it on pointerup.
The gesture's whole footprint — subscriptions included — ends when it does.

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

## A spreadsheet — derives reading derives

Give every cell a derive that parses its formula and reads the cells it
references. Dependency tracking falls out automatically: edit A1 and only
formulas that (indirectly) mention A1 recompute; a formula whose result didn't
change wakes nobody downstream; a reference cycle comes back as `#CYCLE`
instead of a hang. `examples/7guis/cells.ts`, with the test to prove each of
those claims.

## Multi-tab — the wire without a server

One tab wins a Web Lock and hosts over a `BroadcastChannel` transport; every
tab connects as a client. Close the hosting tab and the lock — and the hosting
job — moves to another. The protocol never assumed a server, just a transport.
`examples/multi-tab`.

## A chat room — the wire doing what it's for

A room is a process that reduces posts into a capped history. Host it with
`serve`, look it up by name from every tab, and the whole client-server chat
is the same code you'd write for local state — posts are casts, history
arrives as patches, a dead server shows as `stale: true` until the
reconnecting transport finds it again. `examples/chat`.

## The one-line move

Local registry → `connect(webSocketTransport(url))`. Nothing else changes.
`examples/shared-cart`.
