# The inspector

A process's state lives in `let` bindings inside a suspended generator, which
browser devtools can't see. What they can't see either is the order things
happened in: which message arrived, what the process yielded in response, who
answered which call. `@nonchalant/inspect` records all of that as it happens
and shows it in a panel: the tree of live processes, a timeline of messages,
yields and patches, and the state of any process at any recorded moment.

Yields already travel as patches (the same ops the wire sends), so the
recording is plain data and time travel costs nothing extra: a past state is
a spawn state with some patches applied.

## Turning it on

Mount the panel before the processes you want to watch are spawned. The
recorder only sees what happens after it starts.

```ts
import { mountInspector } from '@nonchalant/inspect'

const dock = document.createElement('aside')
document.body.append(dock)
const panel = mountInspector(dock)

// ... later, to stop recording and remove the panel:
panel[Symbol.dispose]()
```

In the example gallery, add `?inspect` to the URL of the TodoMVC or agent
page (`examples/todomvc/?inspect`); `examples/inspector/enable.ts` docks the
panel along the bottom.

Without a panel, `inspect()` records headlessly, which is handy in tests:

```ts
import { spawn } from '@nonchalant/core'
import type { Cast, Self } from '@nonchalant/core'
import { inspect } from '@nonchalant/inspect'

const insp = inspect({ size: 500 })
const counter = spawn(async function* counter(self: Self<Cast<{ type: 'inc' }>>) {
  let n = 0
  for await (const msg of self) {
    switch (msg.type) {
      case 'inc':
        n++
        break
    }
    yield n
  }
}, undefined, { initial: 0 })

counter.cast({ type: 'inc' })
// once the recorder has caught up:
const yields = insp.timeline().filter((e) => e.type === 'yield')
const first = yields[0]
if (first !== undefined) console.log(insp.stateAt(first.id, first.seq)) // 1
insp[Symbol.dispose]()
```

## What it records

Core has one hook, `instrument(sink)`, which reports every process event to a
single sink, synchronously, as it happens. The inspector is that sink. The
events:

| event | when | carries |
|---|---|---|
| `spawn` | a process starts | id, owner id (`null` when unowned), the generator's function name, the registry name if it came from `lookup`, args, initial state |
| `cast` | a cast is sent (from outside, or `self.cast`) | the message |
| `call` | a call is sent | the request and a call number |
| `reply` | the body answers a call | the call number and the answer |
| `yield` | a yield is published | the patch from the previous state, not the state |
| `status` | `pending`, `stale` or `errored` flips | the three flags |
| `crash` | the body throws | the thrown value |
| `restart` | `restart: 'on-crash'` re-runs the body | the attempt number |
| `exit` | the process leaves `running`, or a finished one is disposed | `'done'`, `'crashed'` or `'disposed'` |

Ids increase by one per spawn and are never reused. The owner id is the
process whose synchronous step did the spawning, the same ownership that
disposal follows; registry processes are never owned, so theirs is `null`.

The recorder turns each event into plain JSON on arrival: messages, replies,
args and state are kept by reference when they are already plain data, and
anything else (functions, errors, dates, class instances, cycles) becomes a
bracketed label such as `'[function reply]'` or `'[Error: boom]'`. A
recording can therefore be `structuredClone`d or serialized whole.

Status flips update the tree but are not timeline rows. Everything else is a
row with a sequence number, kept in a ring of `size` entries (1000 by
default). When the ring is full the oldest quarter drops at once, so most
appends reach the timeline's readers as a single splice
(`record.test.ts`, "keeps at most `size` entries").

The inspector's own processes, and everything they own, are left out:
otherwise recording an event would itself be an event. `insp.adopt(fn)` marks
the processes `fn` spawns as the inspector's own; the panel uses it.

## What it costs when it's off

Every emit site in `process.ts` is an optional call, `sink?.({ ... })`, and an
optional call skips its argument when the callee is missing. With no sink
installed, each event site is one check of a module variable: no event object
is built, and a yield is not diffed a second time. The diff is the one thing
that could be measurably expensive, so it is pinned with an exact count: a
yield is diffed once with no sink and twice with one (`instrument.test.ts`,
"diffs a yield once with no sink installed"). The reconcile perf budget and
the mario golden budgets are unchanged. The hook adds about 220 bytes gzipped
to core (`test/size.test.ts`).

## Time travel

Each process in the recording keeps a `base` state and the sequence number it
holds at, starting as its spawn state at its spawn event. Its state after any
later event `t` is `base` with every retained `yield` patch up to `t` applied
by core's `applyPatch`:

```ts
import { applyPatch } from '@nonchalant/core'
import type { Json } from '@nonchalant/core'
import type { Recording } from '@nonchalant/inspect'

function stateAt(rec: Recording, id: number, seq: number): Json | null | undefined {
  const node = rec.procs[id]
  if (node === undefined || seq < node.baseSeq) return undefined
  let state = node.base
  for (const e of rec.events) {
    if (e.seq > seq) break
    if (e.type === 'yield' && e.id === id && e.seq > node.baseSeq) state = applyPatch(state, e.ops)
  }
  return state
}
```

That is the exported `stateAt` in full. When the ring drops a yield, its
patch is folded into `base` first, so whatever is still in the ring can always
be reconstructed. A moment older than what the ring retains for a process
answers `undefined` rather than a wrong state. A property test drives a sample
reducer with random message sequences and random ring sizes and checks that
the state reconstructed at every retained yield equals the state the process
really yielded there (`record.test.ts`, "reconstructs the exact state each
yield produced").

A process's current state is maintained the same way, one patch at a time, so
the tree never asks the live process for its value. Reading it would make the
inspector a watcher and change what the registry evicts.

## The panel

`mountInspector(el, inspector?)` renders three panes:

- **Processes**: the tree of processes not yet disposed, nested by ownership,
  with `pending`, `stale`, `error` and `done`/`crashed` badges. It is an ARIA
  tree with one tab stop; the arrow keys, Home and End move between items,
  and Enter, Space or a click selects one. Selecting a process filters the
  timeline to it.
- **Timeline**: the newest 200 matching entries, newest first. Each row is a
  button; pressing one picks that moment.
- **Detail**: with a moment picked, the event, its patch if it was a yield,
  and the selected process's state as it was just after that moment (the
  picked event's own process when none is selected). Otherwise the selected
  process's current state. States render as collapsible JSON.

The panel is built with nonchalant: one small process holds the selection,
the rest are bindings over the recording. Rows are cached per recorded object,
so a new event hands the DOM sink reference-equal rows for everything it has
already drawn (`panel.test.ts`).

## Limits

- One sink at a time: a second `inspect()` replaces the first's hook.
- Names come from the generator function's name, which a minifier may
  shorten. Registry processes show their registry name instead.
- Only processes spawned after the inspector starts are recorded.
- `derive` has no mailbox or yields, so it doesn't appear; the processes it
  reads do.

A remote host could forward these events over the wire for inspecting a
server's processes from a browser. That isn't built yet.
