# Processes on the server

[`@nonchalant/core`](../packages/core) has no browser dependency. Its processes
combine a mailbox, generator, and supervision in a model influenced by Erlang
actors. This guide covers server-side use as virtual actors, durable workflows,
and agent loops, along with the library's current limits.

Read [Concepts](concepts.md) first; this assumes processes, the registry, and
the wire.

## What is already an actor

| you want | what it is here |
|---|---|
| a mailbox, in order | `for await (const msg of self)` handles messages sequentially, so repeated submissions queue instead of racing |
| cast and call | `cast` and `call`, kept apart by the type system |
| supervision | `restart: 'on-crash'` with a budget; a terminal crash leaves `error` readable |
| cancellation | pass `self.signal` to fetches; disposal aborts it |
| a linked lifetime | children spawned inside a process die with it |
| addressing by name | `registry.lookup(name, args)` is get-or-spawn |
| activation / deactivation | that lookup activates; `evict` deactivates after idle |

The last two rows describe the lifecycle used by virtual actors such as Orleans
grains and Dapr actors. The first lookup starts an entry, later lookups share
it, and the registry reclaims it after its last watcher leaves and its idle
timer expires.

## Durability

[`@nonchalant/durable`](../packages/durable) records process state for recovery.
It does not add a runtime. `durable(proc, opts)` returns a regular `Proc` that
can be registered, accessed through the wire, and bound to a view.

The process inside is written the way every process in this repo is written,
except that its effects go through `step`:

```ts
import type { Cast } from '@nonchalant/core'
import type { DurableProc } from '@nonchalant/durable'

type Order = { status: 'open' | 'charged' | 'shipped'; total: number; charged: number }
type OrderMsg =
  | Cast<{ type: 'add'; price: number }>
  | Cast<{ type: 'checkout' }>

declare const payments: { charge(amount: number, opts: { key: string }): Promise<{ amount: number }> }

const order: DurableProc<Order, OrderMsg, { id: string }> = async function* (self, _args, d) {
  let s: Order = d.restored ?? { status: 'open', total: 0, charged: 0 }   // the last committed state
  yield s
  for await (const msg of self) {
    switch (msg.type) {
      case 'add':
        s = { ...s, total: s.total + msg.price }
        break
      case 'checkout': {
        if (s.status !== 'open') continue                       // no state change, no yield
        const receipt = await d.step('charge', (key) => payments.charge(s.total, { key }))
        s = { ...s, status: 'charged', charged: receipt.amount }
        yield s
        await d.sleep('cool-off', 3600_000)                     // the deadline is journaled, not the timer
        s = { ...s, status: 'shipped' }
        break
      }
    }
    yield s
  }
}
```

Registering it is the same as registering anything else:

<!-- ts-prelude
import type { Cast } from '@nonchalant/core'
import type { DurableProc } from '@nonchalant/durable'
type Order = { status: 'open' | 'charged' | 'shipped'; total: number; charged: number }
type OrderMsg = Cast<{ type: 'add'; price: number }> | Cast<{ type: 'checkout' }>
declare const order: DurableProc<Order, OrderMsg, { id: string }>
-->
```ts
import { define, registry } from '@nonchalant/core'
import { durable, memoryStore } from '@nonchalant/durable'

const orders = registry({
  order: define(durable(order, { store: memoryStore(), key: (a: { id: string }) => a.id })),
})
```

### What a durable body does differently

Recovery does not resume a suspended generator. It starts the generator again
from the last committed snapshot and redelivers the message that was in
progress. So the body is the same shape as any process, but it has to keep
five rules that an ordinary process can ignore:

- **Start from `d.restored`.** Only what the process yields survives. A local
  variable that isn't part of the yielded state starts over after a restart.
- **Put every side effect in a `step`,** and hand its idempotency key to the
  service it calls. Code outside a step runs again on replay.
- **Keep the steps of one message in the same order.** Replay pairs results
  with steps by position, and refuses to start if the names drift.
- **Expect a self-cast to arrive twice.** A replayed message runs its
  `self.cast` again, so a message a body sends itself should carry enough to
  spot a repeat (`examples/job` tags each `next` with its run and position,
  and ignores one that doesn't match its state).
- **Version the snapshot when its shape changes.** Stored snapshots and queued
  messages outlive the code that wrote them ([Changing the state's shape](#changing-the-states-shape)).

### The transaction boundary is one message

1. A message is journaled **before** it is handled.
2. Each `step` is journaled as it completes.
3. When the process asks for its **next** message, the state it produced, the
   cursor past the handled message, and the answers it gave to calls are
   committed together, in one store transaction.

If the process crashes before the commit, the message is delivered again.
Completed effects are read from the journal instead of running again.

**Published is not committed.** A `yield` reaches readers (a bound view, a wire
client) as soon as it happens, but it is committed only when the process asks
for its next message. A crash in between rolls it back: recovery restores the
previous snapshot and handles the message again, so a reader can see a state
that disappears and then comes back, usually identical because completed steps
return their saved results. Two consequences follow. Don't treat a state you
observed as saved; a caller that needs to know should `call`, because an
answer is released only after its commit. And don't answer a call and then
wait inside the same handler: the answer is held until the handler reaches its
next take, so a `reply` followed by a long `sleep` delays the caller by that
long. End the handler and continue from the next message.

This works because `Self` is an interface. The durable wrapper supplies a
mailbox with acknowledgement behavior without changing the process code.

### What it guarantees, and what it does not

- **A step executes at least once and is recorded exactly once.** A `step`
  whose result was written is replaced by that result on replay, and `fn` is not
  called. An effect that was *in flight* when the process died runs again,
  because its result never landed.
- **Every step gets an idempotency key.** `fn` receives `key#seq#index` — the
  process key, the message's sequence number, the step's position — which is the
  same on every replay of that step. Hand it to the outside world, as
  `payments.charge(…, { key })` does above, and the at-least-once execution
  becomes exactly-once at the provider.
- **The step sequence within one message must be stable.** On replay the
  wrapper checks the name recorded at each index and throws, naming both, if it
  drifted, rather than pairing the wrong result with the wrong effect.
- **Messages must be plain data, and a call must carry an id.** `durable()`
  accepts `Json | DurableCall`, and a call without a `callId` that gets past the
  types is refused at runtime: its caller's promise rejects and nothing is
  journaled. See [Durable calls](#durable-calls).
- **A refused write crashes the process.** Handling a message that could not be
  recorded cannot be recovered safely, so the process fails immediately.

### Poison messages

A message that throws every time it is handled would crash every activation
of its key forever, because the journal redelivers it first. `maxAttempts` bounds
that:

<!-- ts-prelude
import type { Cast } from '@nonchalant/core'
import { define } from '@nonchalant/core'
import { durable, memoryStore } from '@nonchalant/durable'
import type { DurableProc } from '@nonchalant/durable'
type Order = { status: 'open' | 'charged' | 'shipped'; total: number; charged: number }
type OrderMsg = Cast<{ type: 'add'; price: number }> | Cast<{ type: 'checkout' }>
declare const order: DurableProc<Order, OrderMsg, { id: string }>
-->
```ts
const orderDef = define(
  durable(order, {
    store: memoryStore(),
    key: (a: { id: string }) => a.id,
    maxAttempts: 3,
    onPoison: (key, dead) => console.error(`gave up on ${key} #${dead.seq}: ${dead.error}`),
  }),
  { restart: 'on-crash' },
)
```

Each throw while handling a message is recorded in that message's step journal,
so the count survives the crash it records. On the last attempt the message is
moved to a dead letter, in the same commit that steps the cursor past it, and
the state it was handed out against is kept. The crash still surfaces; with
`restart: 'on-crash'` the next instance carries on from the message after. A
store failure is not the message's fault and does not count, and neither does
a host dying outright. Without `maxAttempts` a message is retried on every
activation. `packages/durable/test/guarantees.test.ts` covers each case.

### Changing the state's shape

A snapshot is committed with the `version` the code declared (default 0). When
the code moves on, give it the new version and a `migrate`:

<!-- ts-prelude
import type { Cast } from '@nonchalant/core'
import type { DurableProc } from '@nonchalant/durable'
type Order = { status: 'open' | 'charged' | 'shipped'; total: number; charged: number }
type OrderMsg = Cast<{ type: 'add'; price: number }> | Cast<{ type: 'checkout' }>
import { durable, memoryStore } from '@nonchalant/durable'
-->
```ts
type OrderV1 = Order & { currency: 'EUR' | 'USD' }
declare const orderV1: DurableProc<OrderV1, OrderMsg, { id: string }>

durable(orderV1, {
  store: memoryStore(),
  key: (a: { id: string }) => a.id,
  version: 1,
  migrate: (old, from): OrderV1 =>
    from === 0 ? { ...(old as Order), currency: 'EUR' } : (old as OrderV1),   // version 0 meant EUR
})
```

`migrate` runs once on activation, before the process sees `d.restored`; the
next commit stores the result under the new version. A snapshot from another
version with no `migrate` refuses to start rather than be misread. Messages
still in the log are replayed as written, so a message shape change needs the
handler to accept both for as long as old messages can be pending.

### Several hosts, one key

A mailbox is a single writer only while one activation owns the key. `load`
claims the key by raising its **epoch**, and every write after it — `append`,
`putStep`, `commit` — is conditional on that epoch. A write from an activation
that has since been superseded changes nothing and rejects with `Fenced`; the
wrapper then stops that activation (it ends, it does not crash, so no supervisor
restarts it into a fight). Two hosts that both think they own a key therefore
cannot interleave one log or overwrite each other's snapshot: the later claim
wins (`guarantees.test.ts`, "two activations of one key").

How that maps to real storage:

- **Postgres:** `load` is `UPDATE instances SET epoch = epoch + 1 WHERE key = $1
  RETURNING …`; every write runs in a transaction that begins with
  `SELECT epoch FROM instances WHERE key = $1 FOR UPDATE` (or folds
  `WHERE key = $1 AND epoch = $2` into the update) and throws `Fenced` on zero
  rows.
- **Redis:** keep the epoch in a key; `load` is `INCR`. Writes are one Lua script
  that compares the epoch and aborts with `Fenced` on mismatch (or
  `WATCH epoch` / `MULTI` / `EXEC`, treating a nil reply as `Fenced`).
- **SQLite:** one writer per file already, so `BEGIN IMMEDIATE`, compare the
  stored epoch, write, `COMMIT` — the compare catches a second process on the
  same file.

Fencing keeps the log correct; it does not decide who *should* own a key. That
is placement — a registry per node, a lease, a consistent hash — and it stays
outside the library.

### Timers and the scheduler

`d.sleep(name, ms)` journals its deadline as a step, and the same write tells
the store when the key next needs waking. While the process is live, its own
timer fires. If the process is gone by then (evicted, disposed, or its host
stopped), a scheduler wakes it:

<!-- ts-prelude
import type { Cast } from '@nonchalant/core'
import type { DurableProc } from '@nonchalant/durable'
type Order = { status: 'open' | 'charged' | 'shipped'; total: number; charged: number }
type OrderMsg = Cast<{ type: 'add'; price: number }> | Cast<{ type: 'checkout' }>
declare const order: DurableProc<Order, OrderMsg, { id: string }>
-->
```ts
import { define, registry } from '@nonchalant/core'
import { durable, memoryStore, scheduler } from '@nonchalant/durable'

const store = memoryStore()
const orders = registry({
  order: define(durable(order, { store, key: (a: { id: string }) => a.id }), { evict: 60_000 }),
})

// every second: ask the store which keys are due, and look each one up
const timers = scheduler({ store, wake: (id) => orders.lookup('order', { id }) })
// timers[Symbol.dispose]() stops it
```

The lookup is get-or-spawn. A key that is already live on this node is left
alone. A key that is not live activates, replays its log, finds the sleep's
deadline already passed, and carries on. The evicted order above therefore
ships an hour later with nothing holding it in memory in between. A failed
attempt under `maxAttempts` is also due immediately, so a message that crashed
is redelivered even where no supervisor restarts it.

The store keeps one wake time per key, and a key with unacknowledged messages
always has one. `append` sets it when the key has none, to `redeliverAfter`
(default 30 seconds) from the append: a message still unacknowledged by then
is presumed abandoned. `putStep` replaces it with a deadline. `commit` moves it
to `redeliverAfter` from the commit when messages remain behind the one it
acknowledged, and clears it when none do. `due(now, until, limit)` returns the
due keys, earliest first, and in the same operation moves each one's wake time
to `until`. That is a lease. The scheduler's default lease is 30 seconds.

- **A wake is at-least-once.** If the woken activation dies before it commits,
  the lease runs out and the key comes due again. A scheduler that was down
  catches up on its first pass: everything past due is still in the store.
- **Two schedulers on one store do not both wake a key.** The first `due`
  leases it, and the second does not see it.
- **When they do meet, fencing decides.** If a lease runs out while an
  activation is still working, another scheduler can wake the key elsewhere.
  That later `load` claims the key, and the earlier activation stops at its
  next write. Journaled steps are not run again. The step that was in flight
  runs again under the same idempotency key, which is the usual at-least-once
  rule. Set the lease above your slowest message.

So work in flight is never stranded. If a host stops partway through a
message, its key comes due `redeliverAfter` after that message was journaled,
and a scheduler anywhere on the store resumes it, whether or not anything
looks it up. A key whose messages are all acknowledged has no wake time unless
it is asleep, so idle state costs the scheduler nothing and stays lazy: it
activates on its next lookup. Set `redeliverAfter` above your slowest message;
a live activation that is merely slow gets woken again on its own node (a
no-op lookup), or fenced by another node's.

`packages/durable/test/scheduler.test.ts` covers each case with fake timers:
a sleeping process resuming with no other lookup, a restarted scheduler
catching up, two schedulers waking a key once, a lease that runs out
mid-message being fenced, and a message interrupted with no deadline resumed
once it is overdue.

**Eviction waits for work in flight.** A durable process holds `self.busy()`
while a message is unacknowledged, and a registry does not evict a busy entry,
idle or over its cap. It lets go while parked on a `sleep`, because the
journaled deadline will wake it wherever it is: the order above is evicted
during its hour-long sleep, not kept in memory for it. An explicit `evict()`
still disposes at once; that is how work in flight is stopped.

### Durable calls

Calls into durable processes use a `callId`. The response is recorded under
that ID, and retries with the same ID receive the recorded response:

<!-- ts-prelude
import type { Call } from '@nonchalant/core'
import type { Process } from '@nonchalant/core'
import type { Durable } from '@nonchalant/durable'
declare const d: Durable<{ reserved: number }>
declare const vault: Process<{ balance: number }, Call<{ type: 'reserve'; amount: number; callId: string }, string>>
-->
```ts
// the caller's side: a step whose idempotency key is the callId, so a replay
// calls with the same one
const receipt = await d.call('reserve', (callId) =>
  vault.call({ type: 'reserve', amount: 100, callId }))
```

This provides four behaviors:

- **A repeated call reuses completed work.** The callee replies from its record.
- **Two callers with one ID wait for one response.** The second attaches instead of
  queueing a duplicate.
- **A caller that dies after the answer landed retries and gets the same
  answer.** This matters when one agent delegates to another.
- **An answer is released only once it is committed.** The reply is recorded in
  the same transaction that acknowledges the message, and the caller hears it
  after that lands — so no store, however slow, can acknowledge an answered call
  without its answer, and nobody is told something a crash could take back. If
  the callee dies first, the caller's call rejects, the message is replayed
  from its journal, and the retry gets the answer the replay committed.

Over the wire these hold per principal: the host namespaces every client's
`callId` by the connection's principal. A `scope` that names a stable principal
(the user id) keeps retries idempotent across reconnects; without one, each
connection is its own principal and a retry after a reconnect runs the work
again ([Hosting](hosting.md#durable-call-ids)).

One consequence: a reply is released when the process asks for its next
message, so a handler that replies and then sleeps holds the answer for the
sleep. Reply at the end of the handler, or split the wait into its own message.

A `call` from outside a durable process supplies its own id; that id is the
idempotency key of the whole operation, so it should come from the thing being
done (an order number, a request id), not from a random.

### The store is a port

Eight methods, in [`store.ts`](../packages/durable/src/store.ts): `load`,
`append`, `pending`, `putStep`, `steps`, `commit`, `result`, `due`. The wrapper
and the scheduler know nothing about storage beyond them. An adapter is a plain
object with no required base class or registration step.

Three rules an adapter must honour. `commit` is one transaction: snapshot,
version, cursor, answers, dead letter, and the new wake time (moved to
`wakeAt` if messages remain past the cursor, cleared if none do) land together
or not at all. `append` sets a wake time only on a key that has none. Every write carries the epoch `load` handed out
and is refused with `Fenced` when it is stale. `due` reads due keys and leases
them in one operation, and `load` leaves the wake time alone, so an activation
that dies before committing is woken again. The one retention rule is that answers outlive the message
that produced them, so a real adapter keeps them for a window and then forgets
them — `memoryStore().prune(before)` is that window by hand; a real adapter runs
it as a TTL (`DELETE … WHERE committed_at < $1` on a schedule, or `EXPIRE`).

The package ships only `memoryStore()`, which serves as the reference
implementation and the target of crash-consistency tests. An adapter for a real
store belongs in the repo that owns that driver: `commit` as one transaction,
`append` as one insert, `result` as a lookup in a keyed table with a TTL,
`due` as an indexed select-and-update on the wake time.

An adapter certifies against the contract the way a wire host certifies
against the protocol vectors. `@nonchalant/durable/conformance` exports the
contract as tests, and it takes the test runner's functions as arguments, so it
imports no test framework:

<!-- ts-prelude
import type { MemoryStore } from '@nonchalant/durable'
declare function myStore(now: () => number): MemoryStore
-->
```ts
import { describe, it, expect } from 'vitest'
import { storeConformance } from '@nonchalant/durable/conformance'

storeConformance((now) => myStore(now), { describe, it, expect })
```

It covers every method: epochs and fencing (a stale write changes nothing),
commit atomicity, answers, dead letters, versions, `prune`, wake times and
`due` (two callers overlapping at staggered points get a due key once), and
ordering. `memoryStore` runs it in
`packages/durable/test/conformance.test.ts`, which also runs it against
adapters broken on purpose (a `due` that reads, awaits, then leases; a `load`
that clears the wake time) and asserts each fails exactly the test aimed at it.
[`examples/durable-sqlite`](../examples/durable-sqlite) runs it against a
SQLite adapter built on Node's own `node:sqlite`, using the `BEGIN IMMEDIATE`
mapping described above. The same example also crashes a process partway
through a message on a file and resumes it from the reopened file.

Crash consistency is a property test, not a claim:
`packages/durable/test/durable.test.ts` runs generated crash schedules against
generated workloads and asserts the workflow lands exactly where the
uninterrupted run landed, and `packages/durable/test/calls.test.ts` does the
same for calls on a store slow enough that every write is overtaken, asserting
that each call is answered one way and moves the state once.

## Agents

An agent process receives a question, calls tools, evaluates their responses,
and publishes progress. `examples/agent` includes the loop, a stub model, three
tools, and a page bound to their state.

**Tools can be processes, reached with `call()`.** Their state can be
observed, and the registry makes them available by name. A tool can also hold a
request until a person responds:

<!-- ts-prelude
import type { Call, Cast, Proc } from '@nonchalant/core'
-->
```ts
type ApprovalMsg =
  | Call<{ type: 'request'; tool: string; args: string }, boolean>
  | Cast<{ type: 'decide'; ok: boolean }>
type Request = Extract<ApprovalMsg, { type: 'request' }>

// the approval tool holds the reply until somebody decides
const approvals: Proc<{ pending: number }, ApprovalMsg, void> = async function* (self) {
  let waiting: Request[] = []
  yield { pending: 0 }
  for await (const msg of self) {
    switch (msg.type) {
      case 'request':
        waiting = [...waiting, msg]   // the message carries its own reply
        break
      case 'decide': {
        const [head, ...rest] = waiting
        if (head === undefined) continue
        head.reply(msg.ok)
        waiting = rest
        break
      }
    }
    yield { pending: waiting.length }
  }
}
```

The agent waits with a regular `await`. The pending response represents the
pause, so no separate interrupt protocol is needed.

**Streaming is a yield per chunk.** Keep the growing text as `string[]` and
append: one array append is one splice op, where re-sending a growing string is
the whole string every time. That matters the moment the run is watched over a
wire.

**Cancellation is disposal.** A run is a process with a lifetime; disposing it
aborts `self.signal`, which aborts the request in flight. A durable agent's
unfinished message is then redelivered on the next activation.

**Runs are observable state.** A view can bind to the run locally, while
`connect()` sends remote changes as patches. This uses the standard process API
rather than a separate streaming representation.

The library does not provide a built-in worker fleet, queue, retry policies
beyond `restart` and `maxAttempts`, or an execution console; its scheduler
wakes journaled deadlines and nothing else. Model SDK objects must be mapped to plain
data before they can be state. Long CPU work belongs on another thread
(`examples/worker`).

## Brokers and work queues

Backends commonly use pub/sub systems and work queues. Both can sit behind
ports. `examples/messaging` defines these interfaces and provides in-memory
adapters:

<!-- ts-prelude
import type { Json } from '@nonchalant/core'
type Job = { id: string; body: Json }
-->
```ts
export interface Bus {
  publish(topic: string, event: Json): Promise<void>
  subscribe(topic: string, onEvent: (event: Json) => void): () => void
}

export interface Queue {
  push(body: Json): Promise<string>
  reserve(leaseMs: number): Promise<Job | undefined>   // hidden from others until the lease ends
  ack(id: string): Promise<void>
  release(id: string): Promise<void>
}
```

**A subscription can be a process.** Subscribe during setup, pass each event to
`self.cast`, and unsubscribe during disposal. The external stream becomes state
that a view can bind to. Looking up the process by topic also allows the
registry to share one subscription among all readers of that topic and release
it when the last reader leaves.

**A worker is a process too.** Reserve, handle, acknowledge; release on a
failure instead of losing the job. Poll with a timer rather than a bare
`self.cast`. A mailbox loop that casts to itself synchronously never lets the event
loop turn again.

**At-least-once lives in the queue, not in the worker.** A worker that dies
holding a lease acknowledges nothing, the lease expires, and somebody else gets
the job with `attempts` one higher. That is the same guarantee `durable()`
gives inside a process. The two mechanisms can be combined:
a durable process consuming a queue journals the job as a message, so a
redelivered job that was already handled is recognised rather than repeated.

## Multi-agent wiring

`examples/multi-agent` implements common orchestration patterns with process
code and tests them without a browser.

| the pattern | what it is here |
|---|---|
| single agent | one process (`examples/agent`) |
| agent delegation | the tool is another agent: `d.call('research', (callId) => researcher.call({ …, callId }))` |
| programmatic handoff | the supervisor passes one agent's output to the next as an argument, without a shared blackboard or history object |
| graph-based control flow | `stage` is a field in the state, the code between yields is the edge, and the graph is renderable because it is data |
| usage limits | one budget process everybody asks, inside a `d.step` so a replay does not spend twice |
| shared dependencies | arguments, or a registry lookup for shared resources |
| message history | whatever the supervisor kept in its own state, which is already durable |

Because delegation uses durable calls, restarting the supervisor during a
pipeline does not repeat work already completed by other agents.

Two limits apply. Fan-out uses `Promise.all` over several `d.call`s; each is
keyed by the position it was started at, so the calls must be started in the
same order on every replay (a `map` over state does that), and each should
have its own name so a drift is caught by name. And a supervisor whose node
stops mid-pipeline continues on its next activation. A [scheduler](#timers-and-the-scheduler)
provides that activation only if the supervisor was sleeping or retrying;
otherwise it comes from a lookup.

## Hosting

[`@nonchalant/host`](../packages/host) serves a registry over WebSockets, one
session per connection. Before putting one on the internet, read
[Hosting safely](hosting.md): origin policy, authorization, per-connection
scoping, and the limits that are not on by default.
