# Error handling

What can fail, how each failure shows up, and what to do about it. The model
is the same everywhere: a failure never takes down more than the process or
region it happened in, the last good value stays readable, and whatever was
waiting on an answer is told.

## Processes

A process fails when its generator throws. From the outside:

| read | after a crash |
|---|---|
| `p()` | the last value it yielded, unchanged |
| `p.stale` | `true` |
| `p.error` | the thrown value |
| `p.pending` | `false` (or `true` while a restart is under way) |
| pending or queued `p.call(...)` | rejects with the thrown value |
| later `p.call(...)` | rejects at once: `nonchalant: call on crashed process` |

All three reads are tracked, so a view can show a failure the way it shows
anything else:

<!-- ts-prelude
import type { Process } from '@nonchalant/core'
import { div, p as para } from '@nonchalant/dom/tags'
declare const results: Process<string[]>
-->
```ts
div({},
  para({ hidden: () => !results.stale }, 'showing the last good results'),
  para({}, () => (results.error === undefined ? '' : String(results.error))))
```

**Restarting.** `restart: 'on-crash'` re-runs the generator from its original
arguments after a throw, up to `maxRestarts` times (default 3; `Infinity` is
allowed). Queued casts survive into the new instance and are handled there.
Every call that was waiting, whether the crashed instance had taken it or it
was still queued, rejects with the thrown value and is removed from the
mailbox, so a caller that was told "failed" is never also served by the
restarted instance. Readers see `stale` until the restarted instance yields. Once the budget is spent, the crash is terminal.
Children the crashed instance spawned are disposed with it.

**Throwing on purpose.** Because a crash rejects the pending call, throwing is
a legitimate way to answer one with an error. When the process should survive
the failure, reply with a value that says so instead (`{ ok: false, reason }`)
and keep the loop running; `examples/form` does that.

**Other rejections.** A call also rejects when:

| cause | rejection |
|---|---|
| the process returned | `nonchalant: process ended` |
| the process was disposed | `nonchalant: process disposed` |
| a bounded mailbox dropped the queued call | `nonchalant: call dropped — mailbox overflow or process ended` |
| the call was made after it ended | `nonchalant: call on done process` / `on disposed process` |

**Errors thrown synchronously.** Some misuse throws where it happens instead of
crashing anything: `spawn` with an invalid `mailbox` or `maxRestarts`, `define`
with an invalid `evict`, `lookup` of a name the schema does not have, and
reading a `derive` that was disposed before it ever produced a value.

Also thrown synchronously: `registry` with a `maxEntries` that is not
positive.

**Observing crashes.** By default a crash is visible only on the handle and in
the calls it rejects; nothing is logged. `onProcessError` routes every crash to
one handler, including the ones a restart recovers from, which the handle alone
would hide once the restarted instance yields:

<!-- ts-prelude
declare const report: (error: unknown, context: { process: string }) => void
-->
```ts
import { onProcessError } from '@nonchalant/core'

const stop = onProcessError((error, name) => {
  report(error, { process: name })   // name is the generator function's name
})
stop()                               // removes this handler
```

The handler runs a microtask after the crash, so one that throws surfaces as an
unhandled rejection rather than disturbing the process. There is one handler at
a time; installing another replaces it.

## Derives and effects

A `derive` whose function throws rethrows on read and exposes the error as
`d.error`; its previous value is kept internally, and the next successful
recompute clears the error. Iterating a failing derive throws from `next()`.

An `effect` that throws on its first run is stopped and the error is thrown
from `effect()` itself. One that throws on a later run is reported from the
flush that ran it: `flush()` runs every queued effect, then rethrows the first
error. The automatic flush runs on a microtask, so there an effect error
surfaces as an uncaught exception. Catch inside the effect when a failure is
expected.

## Rendering

A binding that throws, or a promise in a slot that rejects, is contained to its
own region: the region keeps its previous content and the rest of the page
keeps updating. The failure is reported to `console.error` unless you route it:

```ts
import { onRenderError } from '@nonchalant/dom'

const restore = onRenderError((what, error) => {
  console.warn(`render failed: ${what}`, error)   // or send it to your error reporting
})
restore()                                          // back to the previous handler
```

A view process that crashes is a process crash: its region keeps the last tree
it yielded.

## The wire

Remote processes have the same face as local ones, and every remote failure
arrives as a `WireError`, whose `detail` is the JSON the host sent (at least
`{ message }`; the host never sends stacks).

| what happened | `p.stale` / `p.error` | pending calls |
|---|---|---|
| the remote process crashed | `true` / `WireError` | reject with the host's error |
| the host rejected one call | unchanged | that call rejects with the host's error |
| the remote process ended | unchanged | reject: `process ended` |
| the connection dropped | `true` / `WireError('transport disconnected')` | reject: `transport disconnected` |
| the facade was disposed | `true` | reject: `process disposed` |
| lookup of a name not in the host's schema | `true` / `WireError` | reject |
| lookup past the host's watch cap | `true` / `WireError('watch limit reached')` | reject |
| lookup past the host's rate limit | `true` / `WireError('lookup rate exceeded')` | reject |
| lookup with a different protocol revision | `true` / `WireError('protocol mismatch: host speaks 3, lookup carried …')` | reject |
| a call whose message is not an object with a string `type` | unchanged | that call rejects: `invalid message: expected an object with a string type` |
| a call the gateway's `admit` refused (returned `undefined` or threw) | unchanged | that call rejects: `message refused` |
| a call on a ref the host is not watching | unchanged | that call rejects: `no such process` |
| a call to a process that accepts no calls | unchanged | that call rejects: `not callable` |

A dropped connection is not terminal. On reconnect the client looks every live
process up again, receives its full state, and diffs it against the value it
kept: readers of unchanged paths never wake, and `stale` clears. A call is not
retried across a disconnect (the host may or may not have run it), so a caller
that needs at-least-once delivery retries itself, and one that needs
exactly-once calls a durable process with a call id.

A cast that fails the same checks (malformed, refused by `admit`, or sent to
an unknown ref) is dropped without a reply: a cast has nowhere to report to.
Casts made while disconnected are not lost: the client queues the newest 64
per ref and sends them right after the re-lookup. Replies are not ordered
against yields, so after `await p.call(...)` the value `p()` may not yet show
that call's effect; return what the caller needs in the reply.

## Durable processes

`durable(proc)` turns crashes into redeliveries rather than hiding them. What
can go wrong:

- **The process throws while handling a message.** It crashes like any other
  process. Nothing was committed for that message, so on the next activation
  (a restart, or the next lookup after eviction) the message is delivered
  again, with the `step` effects it had completed answered from the journal.
  Use `restart: 'on-crash'` on the definition to reactivate at once.
- **The store rejects a write.** A failed `append` crashes the process the next
  time it asks for a message: handling a message that was never recorded is
  the one thing durability cannot survive. A failed `commit` or `putStep`
  crashes it where it happens. Either way the journal still says where to
  resume.
- **Steps run in a different order on replay.** `step` throws
  `nonchalant/durable: step order drifted in '<key>' #<seq>: step <n> was 'a', now 'b'`. The
  order of steps within a message must not depend on anything unrecorded;
  put the non-deterministic input inside a `step`.
- **A retried call.** A call carries a `callId`; if the process already
  answered that id, the retry gets the recorded answer and nothing runs again.
  A call without a string `callId` is refused before it is journaled: it
  rejects with `nonchalant/durable: a call needs a callId`.
- **A message that crashes every time.** With `maxAttempts: n`, each crash
  while handling a message is recorded against it in the step journal (store
  failures and a host dying outright do not count). On the `n`th crash the
  message is committed as a dead letter: the state rolls back to what it was
  before the message, the cursor steps past it, `onPoison(key, dead)` is
  called with the message and the last error, and the crash still happens, so
  the next activation starts on the following message. Without `maxAttempts`
  a poison message is redelivered on every activation. `memoryStore().dead(key)` lists a
  key's dead letters.
- **Two activations of one key.** Each `load` raises the key's epoch, and every
  write carries the epoch its activation loaded. A write from an older
  activation rejects with `Fenced` and changes nothing; the durable process
  that meets it returns quietly (it ends rather than crashing) and leaves the
  key to the newer activation. Callers still attached to the old one see a
  finished process.
- **A snapshot from another version.** A key committed under a different
  `version` is passed through `migrate(old, from)` on load. With no `migrate`,
  the process crashes on activation with
  `nonchalant/durable: no migrate for '<key>' from version <from> to <to>`,
  before any message is handled.

## Hosting

`serve` refuses a connection before any process sees it: a failed
`authorize` or origin check rejects the upgrade, and a `scope` that throws
rejects it with a 500. Once connected, a message larger than
`maxPayloadBytes` closes the socket with code 1009, a missed heartbeat
terminates it, and so does more than `maxBufferedBytes` of output queued for a
client that has stopped reading. On the client these all look like a dropped connection.
[Hosting safely](hosting.md) covers which limits to set.
