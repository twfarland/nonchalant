# Recipes

Userland patterns with no privileged access — each is a few lines over the
primitives, and most exist as runnable code in `examples/`. When a recipe
covers a problem, it stays a recipe; new core concepts must dissolve at least
two existing problems to earn a place (the registry test).

## Transient widget state — `cell`

```ts
function cell<T>(initial: T): Process<T, T> {
  return spawn<T, T, void>(async function* (self) {
    for await (const next of self) yield next
  }, undefined, { initial })
}
```

Shipped as sugar because everyone needs it; owned by the enclosing scope, dead
with the widget. `examples/counter`.

## Typeahead — cancellation and racing

`self.latest()` is flatMapLatest as an iteration mode: while the fetch is in
flight the loop is not listening; on completion it resumes at the newest
pending query. `self.signal` aborts in-flight work on dispose.

```ts
for await (const { q } of self.latest()) {
  yield { q, results, pending: true }
  try {
    results = await api.search(q, { signal: self.signal })
    yield { q, results, pending: false }
  } catch { /* aborted or failed; continue */ }
}
```

`examples/typeahead`.

## Forms — ask for the answer

The submit is a `Call`; the form learns whether its own submission succeeded
as a typed promise instead of grovelling through yielded status fields.
`examples/form`.

## The query cache — twenty lines of registry

```ts
const users = registry({
  user: define(async function* (self, { id }: { id: number }) {
    yield await fetchUser(id)
    for await (const _ of self) void _      // stay alive for watchers
  }, { evict: 30_000 }),
})
users.lookup('user', { id: 1 })             // dedup by key, shared, refcounted, idle-evicted
```

That is queryKey + SWR + cache lifecycle. The recipe's test:
`packages/core/test/registry.test.ts` ("the query-cache recipe").

## Routing — a process of the current path

The route is state like any other; a lazy route is a thunk resolving through
`import()` — the sink keeps the previous page until the chunk lands and a
newer navigation supersedes a stale load. `examples/router`.

## Undo/redo — middleware is function composition

Wrap a proc, hand the inner one a private `channel`, own the history in the
wrapper. Same shape gives logging, persistence, time-travel, replay.
`examples/undo-redo`; a snapshot-grouping variant (radius drags collapse to
one step) in `examples/7guis/circle-drawer.ts`.

## Drag — an interaction with a lifetime

Spawn a process on pointerdown that yields offsets and dies on pointerup:
gesture state with a scope instead of a tangle of listeners.

```ts
el.addEventListener('pointerdown', (down: PointerEvent) => {
  const gesture = spawn(async function* (self: Self<PointerEvent>) {
    for await (const move of self)
      yield { dx: move.clientX - down.clientX, dy: move.clientY - down.clientY }
  }, undefined)
  const onMove = (e: PointerEvent): void => gesture.send(e)
  const onUp = (): void => {
    removeEventListener('pointermove', onMove)
    removeEventListener('pointerup', onUp)
    gesture[Symbol.dispose]()          // the gesture's lifetime ends here — and
  }                                    // everything reading it goes quiet with it
  addEventListener('pointermove', onMove)
  addEventListener('pointerup', onUp)
  const stop = effect(() => { const o = gesture(); if (o) applyOffset(o) })
  void stop // disposed with the gesture's readers, or keep and call on onUp
})
```

(Sketch — adapt to taste; the point is the lifetime, not the listener wiring.)

## A spreadsheet — derivations all the way down

Cell values as lazily-created derives that resolve references by reading each
other: dependency tracking is automatic and exact, the equality cut stops
propagation where values don't change, and an evaluation stack turns cycles
into `#CYCLE` instead of hangs. `examples/7guis/cells.ts` + its test.

## Multi-tab — the wire without a server

One tab hosts over a `BroadcastChannel` transport, the rest connect; the
protocol never assumed a server, only a transport. `examples/multi-tab`.

## The one-line move

Local registry → `connect(webSocketTransport(url))`. `examples/shared-cart`.
