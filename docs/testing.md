# Testing processes

Because process inputs and outputs are explicit, most behavior can be tested
without a UI. This guide presents three levels of testing, from pure functions
to the full runtime, with examples from the repository.

## Level 1: pure functions

Keep independent calculations in pure functions. Physics steps, filters, and
formatters can then use direct input/output tests.

```ts
expect(step(1, { x: 1, y: 0 }, initialMario)).toEqual({ ... })
expect(visible({ todos, filter: 'active' })).toHaveLength(1)
```

Seen in: `examples/mario/mario.golden.test.ts` (a whole jump arc),
`examples/todomvc/todos.test.ts` (the pure helpers).

## Level 2: the generator, driven directly

`Self` is an interface implemented by `channel()`, allowing tests to drive the
async generator directly. This level does not require `spawn`, the runtime,
timers, or a DOM:

```ts
const self = channel<Msg>()
self.cast({ type: 'add', title: 'milk' })   // script the mailbox up front
self.cast({ type: 'toggle', id: 1 })

const it = todosProc(self, undefined)
expect((await it.next()).value.todos).toEqual([{ id: 1, title: 'milk', done: false }])
expect((await it.next()).value.todos[0].done).toBe(true)
```

Each message produces a yield, so the test reads as a **transcript**. A small
`transcript(proc, msgs)` helper can collect these yields for table-based
assertions. See `examples/todomvc/todos.test.ts`.

Two habits make this level go further:

- **Time is a message.** Mario takes `{ type: 'tick', delta }` instead of
  reading a clock, so tests step frames exactly and never sleep. Any process
  that owns a timer can be given its ticks the same way.
- **Pass dependencies as arguments.** The typeahead process takes `{ api }`; supply
  a scripted fake and drive races deterministically.

## Level 3: the spawned process

Spawn when the test is *about* runtime semantics: lifecycle, ownership,
sharing, granularity.

- **Process state.** `p()`, `p.pending`, `p.stale`, and `p.error` are synchronous
  reads. Assert a loading state with `expect(p.pending).toBe(true)`, not a render
  probe. `call()` returns a promise, and its rejections are the
  crash-behavior test: `packages/core/test/process.test.ts`.
- **Exact wake counts.** Granularity is observable: count effect runs (or DOM
  writes) and assert the precise number, because the model promises exactness
  (`packages/core/test/graph.test.ts`, `packages/dom/test/dom.test.ts`, and
  `examples/query/shop.test.ts` for write-through mutations and failure resync).
- **Ownership and leaks.** Dispose and assert release with `WeakRef` +
  `gc({ execution: 'async' })`; see `packages/core/test/process.leaks.test.ts`
  (note: plain `gc()` false-fails under V8's conservative stack scanning).
  When assertions depend on an asynchronous `finally` block, use
  `await p[Symbol.asyncDispose]()`; synchronous disposal only starts teardown.
- **The wire without sockets.** `memoryPair()` is a transport with
  `disconnect()`, `reconnect()`, and `settle()`, making partition tests concise.
  See `packages/wire/test/wire.test.ts`. The conformance vectors in
  `packages/wire/spec/` are the same idea across languages.
- **Properties where a contract is universally quantified.** Five claims are
  about *every* state, patch, message, or crash schedule rather than the cases
  we thought of, so they are fast-check properties:
  `reconcile(prev, next)` round-trips and never mutates its inputs
  (`reconcile.test.ts`); a reader wakes whenever what it read changed and never
  for a write that landed elsewhere (`graph.test.ts`); a decoded message is
  always well formed and never decodes as the other direction
  (`wire.test.ts`); and the client ends up holding exactly the host's state
  whatever the order of messages and partitions (`wire.test.ts`); and a durable
  workflow lands where the uninterrupted run landed no matter where it was
  killed (`packages/durable/test/durable.test.ts`). When you add one, mutate the
  implementation to confirm that the property fails when the contract is
  broken.

## Views are data

A view function returns a `VNode` tree made from plain objects. Tests can call
the view, inspect the tree, and invoke handlers without creating a DOM:

```ts
const tree = TodoItem(store, { id: 1, title: 'milk', done: false })
const checkbox = tree.children[0].children[0]           // typed plain data
checkbox.attrs.onchange()                               // handlers are closures
await tick()                                            // the cast reaches the mailbox
expect(store().todos[0]!.done).toBe(true)               // the store moved
```

The handler is a closure over `cast`, so the assertion is about the state
process, not the tree: one `await tick()` (`new Promise((r) => setTimeout(r, 0))`)
lets the mailbox turn before the store publishes its next value.

When you do want real nodes, happy-dom runs the sink fast, and the DOM-write
spies in `packages/dom/test/dom.test.ts` show how to assert granularity
budgets against it.

## Summary

| advantage | why it exists |
|---|---|
| the mailbox is injectable | `Self` is an interface; `channel()` implements it |
| tests are transcripts | one yield per message is an assertable sequence |
| no fake timers | time arrives as messages you cast |
| loading/error states are reads | `pending` / `stale` / `error` are the process face |
| request/response is `await` | `call()` returns a promise |
| views test without a DOM | trees are plain data; handlers are closures |
| granularity is countable | wakes and DOM writes are exact, so assert exact numbers |
| partitions are a method call | the in-memory transport can split and heal |
| contracts can be quantified | states, patches, and messages are plain data, so fast-check can generate them |
