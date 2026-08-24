# Processes on the server

Nothing in [`@nonchalant/core`](../packages/core) is about the browser. A
process is a mailbox, a generator, and a supervisor: the same shape an actor
has had since Erlang. This page is about using that on the server — as a
virtual actor, as an agent loop, and as a durable workflow — and about what the
library deliberately does not do for you.

Read [Concepts](concepts.md) first; this assumes processes, the registry, and
the wire.

## What is already an actor

| you want | what it is here |
|---|---|
| a mailbox, in order | `for await (const msg of self)` — sequential by default, so a double-submit queues instead of racing |
| cast and call | `send` and `ask`, kept apart by the type system |
| supervision | `restart: 'on-crash'` with a budget; a terminal crash leaves `error` readable |
| cancellation | `self.signal` — thread it into every fetch; disposal aborts it |
| a linked lifetime | children spawned inside a process die with it |
| addressing by name | `registry.lookup(name, args)` is get-or-spawn |
| activation / deactivation | that lookup activates; `evict` deactivates after idle |

That last pair is the virtual-actor lifecycle (Orleans grains, Dapr actors)
without a new noun: an entry is spawned on first lookup, shared by every later
one, and reclaimed when the last watcher leaves and the idle timer expires.

## Durability

[`@nonchalant/durable`](../packages/durable) wraps a process and writes it
down. It adds no runtime and no scheduler: `durable(proc, opts)` returns an
ordinary `Proc`, so it goes into a registry, over the wire, and under a view
like anything else.

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

Crash anywhere in between and the message is redelivered with its finished
effects already answered: the generator re-runs, and those effects do not.

This is why `Self` being an interface matters. The process iterates a mailbox
that acknowledges, and cannot tell the difference.

### What it guarantees, and what it does not

- **Journaled steps are exactly-once.** A `step` whose result was written is
  replaced by that result on replay; `fn` is not called.
- **Everything else is at-least-once.** An effect that was *in flight* when the
  process died runs again, because its result never landed. Give the outside
  world an idempotency key — that is what `{ key: args.id }` is doing above.
- **The step sequence within one message must be stable.** On replay the
  wrapper checks the name recorded at each index and throws if it drifted,
  rather than pairing the wrong result with the wrong effect.
- **Messages must be plain data, and a call must carry an id.** `durable()`
  accepts `Json | DurableCall`: a message that cannot be written down cannot be
  redelivered, and a call without an idempotency key cannot be answered twice
  safely. See [Durable calls](#durable-calls).
- **A refused write crashes the process.** Handling a message that could not be
  written down is the one thing durability cannot survive, so it is loud.
- **A mailbox is a single writer only while one node owns the name.** Several
  hosts activating the same id need a lease or fencing token in the store.
  That is a distributed-systems problem, and it is outside the library.

### Durable calls

A durable process is only worth calling if the call is durable too. `ask` into
one carries a `callId`, the answer is recorded under that id, and a retry with
the same id is answered from the record:

```ts
// the caller's side: journaled, and the id is derived from (key, message, name)
// so a replay asks with the same one
const receipt = await d.call('reserve', (callId) =>
  vault.ask({ type: 'reserve', amount: 100, callId }))
```

Which gives four behaviours worth naming:

- **A repeated call does no work twice.** The callee replies from its record.
- **Two callers on one id wait on one answer.** The second attaches instead of
  queueing a duplicate.
- **A caller that dies after the answer landed retries and gets the same
  answer** — the case that matters when one agent delegates to another.
- **A callee that answered but died before acknowledging does not re-handle the
  message.** The recorded answer acknowledges it on the next activation.

An `ask` from outside a durable process supplies its own id; that id is the
idempotency key of the whole operation, so it should come from the thing being
done (an order number, a request id), not from a random.

### The store is a port

Eight methods, in [`store.ts`](../packages/durable/src/store.ts): `load`,
`append`, `pending`, `putStep`, `steps`, `commit`, `result`, `putResult`. The
wrapper knows nothing about storage beyond them, and an adapter is a plain
object — no base class, no registration.

The one ordering rule an adapter must honour is that `commit` writes the
snapshot and the cursor together or writes neither. The one retention rule is
that call results outlive the message that produced them, so a real adapter
needs a window after which it forgets them.

This repo ships `memoryStore()` only — the reference implementation and the
test rig the crash-consistency property runs against. An adapter for a real
store belongs in the repo that owns that driver: `commit` as one transaction,
`append` as one insert, `result`/`putResult` as a keyed table with a TTL.

Crash consistency is a property test, not a claim:
`packages/durable/test/durable.test.ts` runs generated crash schedules against
generated workloads and asserts the workflow lands exactly where the
uninterrupted run landed.

## Agents

An agent loop is a process that takes a question, calls out, looks at what came
back, and yields as it goes. `examples/agent` is the whole thing — the loop, a
stubbed model, three tools, and a page bound to it.

**Tools are processes; a tool call is `ask()`.** A tool has state you can watch,
can be reached by name from anywhere, and — since a process replies when it
feels like it — can wait for a person:

```ts
// the approval tool: the reply is simply not sent until somebody decides
for await (const msg of self) {
  if (msg.type === 'request') waiting = [...waiting, { ...msg, reply: msg.reply }]
  else { waiting[0]?.reply(msg.ok); waiting = waiting.slice(1) }
  yield state()
}
```

The agent's side is an ordinary `await` that takes as long as it takes. There
is no interrupt protocol, because a pending reply already is one.

**Streaming is a yield per chunk.** Keep the growing text as `string[]` and
append: one array append is one splice op, where re-sending a growing string is
the whole string every time. That matters the moment the run is watched over a
wire.

**Cancellation is disposal.** A run is a process with a lifetime; disposing it
aborts `self.signal`, which aborts the request in flight. A durable agent's
unfinished message is then redelivered on the next activation.

**Observability is free.** The run *is* state, so a view binds to it locally
and `connect()` streams it as patches remotely. There is no separate streaming
API, because there is no separate representation.

Honest limits: no built-in fleet, queue, scheduler, retry policies beyond
`restart`, or execution console. Model SDK objects have to be mapped to plain
data before they can be state. Long CPU work belongs on another thread
(`examples/worker`).

## Multi-agent wiring

The patterns the agent frameworks name are, here, four ways of writing ordinary
process code. `examples/multi-agent` runs all four in one page and tests them
headlessly.

| the pattern | what it is here |
|---|---|
| single agent | one process (`examples/agent`) |
| agent delegation | the tool is another agent: `d.call('research', (callId) => researcher.ask({ …, callId }))` |
| programmatic hand-off | the supervisor passes one agent's output to the next as an argument — no shared blackboard, no history object |
| graph-based control flow | `stage` is a field in the state, the code between yields is the edge, and the graph is renderable because it is data |
| usage limits | one budget process everybody asks, inside a `d.step` so a replay does not spend twice |
| shared dependencies | arguments. A registry lookup for anything shared |
| message history | whatever the supervisor kept in its own state, which is already durable |

The property this arrangement has, and a graph runtime usually does not: kill
the supervisor mid-pipeline and the agents it already delegated to do not
redo their work, because the delegation was a durable call.

Two limits worth stating. Fan-out is `Promise.all` over several `d.call`s —
fine, but the step journal records them in completion order, so give each one
its own name. And there is no scheduler: a supervisor is a process, and if the
node holding it is gone, something has to look it up again for it to continue.

## Hosting

[`@nonchalant/host`](../packages/host) serves a registry over WebSockets, one
session per connection. Before putting one on the internet, read
[Hosting safely](hosting.md): origin policy, authorization, per-connection
scoping, and the limits that are not on by default.
