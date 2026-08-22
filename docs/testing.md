# Testing processes

Process inputs and outputs are explicit, so most behavior can be tested
without a UI. This page uses three levels, from plain functions to the full
runtime, and points each pattern at a test in this repository.

## Level 1: pure functions

Keep computation out of the loop and it needs no machinery at all. Physics
steps, filters, formatters — plain functions, plain tests.

```ts
expect(step(1, { x: 1, y: 0 }, initialMario)).toEqual({ ... })
expect(visible({ todos, filter: 'active' })).toHaveLength(1)
```

Seen in: `examples/mario/mario.golden.test.ts` (a whole jump arc),
`examples/todomvc/todos.test.ts` (the pure helpers).

## Level 2: the generator, driven directly

This is the level other architectures don't have. `Self` is an interface and
`channel()` is a real implementation of it — so a process can be tested as
the plain async generator it is. No spawn, no runtime, no timers, no DOM:

```ts
const self = channel<Msg>()
self.send({ type: 'add', title: 'milk' })   // script the mailbox up front
self.send({ type: 'toggle', id: 1 })

const it = todosProc(self, undefined)
expect((await it.next()).value.todos).toEqual([{ id: 1, title: 'milk', done: false }])
expect((await it.next()).value.todos[0].done).toBe(true)
```

Message in, yield out — the test reads as a **transcript**, and the whole
suite for a reducer-style process runs in single-digit milliseconds. Wrap the
pattern in a five-line `transcript(proc, msgs)` helper and assertions become
tables. Seen in: `examples/todomvc/todos.test.ts`.

Two habits make this level go further:

- **Time is a message.** Mario takes `{ type: 'tick', delta }` instead of
  reading a clock, so tests step frames exactly and never sleep. Any process
  that owns a timer can be given its ticks the same way.
- **Dependencies are args.** The typeahead process takes `{ api }` — hand it
  a scripted fake and drive races deterministically.

## Level 3: the spawned process

Spawn when the test is *about* runtime semantics: lifecycle, ownership,
sharing, granularity.

- **Faces.** `p()`, `p.pending`, `p.stale`, `p.error` are synchronous reads —
  asserting a loading state is `expect(p.pending).toBe(true)`, not a render
  probe. `ask()` is just an awaited promise, and its rejections are the
  crash-behavior test: `packages/core/test/process.test.ts`.
- **Exact wake counts.** Granularity is observable: count effect runs (or DOM
  writes) and assert the precise number, because the model promises exactness
  — `packages/core/test/graph.test.ts`, `packages/dom/test/dom.test.ts`,
  `examples/query/shop.test.ts` (write-through mutations, failure re-sync).
- **Ownership and leaks.** Dispose and assert release with `WeakRef` +
  `gc({ execution: 'async' })` — `packages/core/test/process.leaks.test.ts`
  (note: plain `gc()` false-fails under V8's conservative stack scanning).
  When assertions depend on an asynchronous `finally` block, use
  `await p[Symbol.asyncDispose]()`; synchronous disposal only starts teardown.
- **The wire without sockets.** `memoryPair()` is a transport with
  `disconnect()` / `reconnect()` / `settle()` — partition tests are three
  lines: `packages/wire/test/wire.test.ts`. The conformance vectors in
  `packages/wire/spec/` are the same idea across languages.

## Views are data

A view function returns a `VNode` tree — plain objects. You can test a view
without any DOM: call it, walk the tree, and invoke its handlers, which are
just closures over `send`:

```ts
const tree = TodoItem(store, { id: 1, title: 'milk', done: false })
const checkbox = tree.children[0].children[0]          // typed plain data
checkbox.attrs.onchange()                               // handlers are closures
expect((await it.next()).value.todos[0].done).toBe(true)
```

When you do want real nodes, happy-dom runs the sink fast, and the DOM-write
spies in `packages/dom/test/dom.test.ts` show how to assert granularity
budgets against it.

## What the model buys you, summarized

| advantage | why it exists |
|---|---|
| the mailbox is injectable | `Self` is an interface; `channel()` implements it |
| tests are transcripts | one yield per message is an assertable sequence |
| no fake timers | time arrives as messages you send |
| loading/error states are reads | `pending` / `stale` / `error` are the process face |
| request/response is `await` | `ask()` returns an ordinary promise |
| views test without a DOM | trees are plain data; handlers are closures |
| granularity is countable | wakes and DOM writes are exact, so assert exact numbers |
| partitions are a method call | the in-memory transport can split and heal |
