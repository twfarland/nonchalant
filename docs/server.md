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
| cast and call | `send` and `ask`, kept apart by the type system |
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
It does not add a runtime or scheduler. `durable(proc, opts)` returns a regular
`Proc` that can be registered, accessed through the wire, and bound to a view.

```ts
import { durable, memoryStore } from '@nonchalant/durable'

const orders = registry({
  order: define(durable(order, { store: memoryStore(), key: (a: { id: string }) => a.id })),
})
```

The process inside is written the way every process in this repo is written,
except that its effects go through `step`:

```ts
const order: DurableProc<Order, OrderMsg, { id: string }> = async function* (self, args, d) {
  let s: Order = d.restored ?? { status: 'new', charged: 0 }   // the last committed state
  yield s
  for await (const msg of self) {
    const receipt = await d.step('charge', () => payments.charge(s.total, { key: args.id }))
    s = { ...s, status: 'charged', charged: receipt.amount }
    yield s
    await d.sleep('cool-off', 24 * 3600_000)                   // the deadline is journaled, not the timer
  }
}
```

### The transaction boundary is one message

1. A message is journaled **before** it is handled.
2. Each `step` is journaled as it completes.
3. When the process asks for its **next** message, the state it produced and the
   cursor past the handled message are committed together.

If the process crashes before the commit, the message is delivered again.
Completed effects are read from the journal instead of running again.

This works because `Self` is an interface. The durable wrapper supplies a
mailbox with acknowledgement behavior without changing the process code.

### What it guarantees, and what it does not

- **Journaled steps are exactly-once.** A `step` whose result was written is
  replaced by that result on replay; `fn` is not called.
- **Everything else is at-least-once.** An effect that was *in flight* when the
  process died runs again, because its result never landed. Give the outside
  world an idempotency key, as `{ key: args.id }` does above.
- **The step sequence within one message must be stable.** On replay the
  wrapper checks the name recorded at each index and throws if it drifted,
  rather than pairing the wrong result with the wrong effect.
- **Messages must be plain data, and a call must carry an id.** `durable()`
  accepts `Json | DurableCall`: a message that cannot be written down cannot be
  redelivered, and a call without an idempotency key cannot be answered twice
  safely. See [Durable calls](#durable-calls).
- **A refused write crashes the process.** Handling a message that could not be
  recorded cannot be recovered safely, so the process fails immediately.
- **A mailbox is a single writer only while one node owns the name.** Several
  hosts activating the same id need a lease or fencing token in the store.
  That is a distributed-systems problem, and it is outside the library.

### Durable calls

Calls into durable processes use a `callId`. The response is recorded under
that ID, and retries with the same ID receive the recorded response:

```ts
// the caller's side: journaled, and the id is derived from (key, message, name)
// so a replay asks with the same one
const receipt = await d.call('reserve', (callId) =>
  vault.ask({ type: 'reserve', amount: 100, callId }))
```

This provides four behaviors:

- **A repeated call reuses completed work.** The callee replies from its record.
- **Two callers with one ID wait for one response.** The second attaches instead of
  queueing a duplicate.
- **A caller that dies after the answer landed retries and gets the same
  answer.** This matters when one agent delegates to another.
- **A callee that answered but died before acknowledging does not re-handle the
  message.** The recorded answer acknowledges it on the next activation.

An `ask` from outside a durable process supplies its own id; that id is the
idempotency key of the whole operation, so it should come from the thing being
done (an order number, a request id), not from a random.

### The store is a port

Eight methods, in [`store.ts`](../packages/durable/src/store.ts): `load`,
`append`, `pending`, `putStep`, `steps`, `commit`, `result`, `putResult`. The
wrapper knows nothing about storage beyond them. An adapter is a plain object
with no required base class or registration step.

The one ordering rule an adapter must honour is that `commit` writes the
snapshot and the cursor together or writes neither. The one retention rule is
that call results outlive the message that produced them, so a real adapter
needs a window after which it forgets them.

This repository ships only `memoryStore()`, which serves as the reference
implementation and the target of crash-consistency tests. An adapter for a real
store belongs in the repo that owns that driver: `commit` as one transaction,
`append` as one insert, `result`/`putResult` as a keyed table with a TTL.

Crash consistency is a property test, not a claim:
`packages/durable/test/durable.test.ts` runs generated crash schedules against
generated workloads and asserts the workflow lands exactly where the
uninterrupted run landed.

## Agents

An agent process receives a question, calls tools, evaluates their responses,
and publishes progress. `examples/agent` includes the loop, a stub model, three
tools, and a page bound to their state.

**Tools can be processes, with `ask()` used for calls.** Their state can be
observed, and the registry makes them available by name. A tool can also hold a
request until a person responds:

```ts
// the approval tool holds the reply until somebody decides
for await (const msg of self) {
  if (msg.type === 'request') waiting = [...waiting, { ...msg, reply: msg.reply }]
  else { waiting[0]?.reply(msg.ok); waiting = waiting.slice(1) }
  yield state()
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

The library does not provide a built-in worker fleet, queue, scheduler, retry
policies beyond `restart`, or an execution console. Model SDK objects must be mapped to plain
data before they can be state. Long CPU work belongs on another thread
(`examples/worker`).

## Brokers and work queues

Backends commonly use pub/sub systems and work queues. Both can sit behind
ports. `examples/messaging` defines these interfaces and provides in-memory
adapters:

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
`self.send`, and unsubscribe during disposal. The external stream becomes state
that a view can bind to. Looking up the process by topic also allows the
registry to share one subscription among all readers of that topic and release
it when the last reader leaves.

**A worker is a process too.** Reserve, handle, acknowledge; release on a
failure instead of losing the job. Poll with a timer rather than a bare
`self.send`. A mailbox loop that re-sends synchronously never lets the event
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
| agent delegation | the tool is another agent: `d.call('research', (callId) => researcher.ask({ …, callId }))` |
| programmatic handoff | the supervisor passes one agent's output to the next as an argument, without a shared blackboard or history object |
| graph-based control flow | `stage` is a field in the state, the code between yields is the edge, and the graph is renderable because it is data |
| usage limits | one budget process everybody asks, inside a `d.step` so a replay does not spend twice |
| shared dependencies | arguments, or a registry lookup for shared resources |
| message history | whatever the supervisor kept in its own state, which is already durable |

Because delegation uses durable calls, restarting the supervisor during a
pipeline does not repeat work already completed by other agents.

Two limits apply. Fan-out uses `Promise.all` over several `d.call`s, and the
step journal records them in completion order, so each call needs a distinct
name. There is also no scheduler. If the node hosting a supervisor stops,
something must look it up again before it can continue.

## Hosting

[`@nonchalant/host`](../packages/host) serves a registry over WebSockets, one
session per connection. Before putting one on the internet, read
[Hosting safely](hosting.md): origin policy, authorization, per-connection
scoping, and the limits that are not on by default.
