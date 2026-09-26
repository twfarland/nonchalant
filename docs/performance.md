# Performance

This page separates two claims that are easy to run together.

**Update precision** is what the CI budgets assert: which bindings re-run
after a change, and exactly which DOM writes, moves, and inserts it causes.
Those counts come from the mechanism, not the machine, so they are asserted
exactly and never vary between runs.

**Throughput and latency** are how long an update takes from message to
settled DOM, and how much memory the result holds. They depend on the
machine, the runtime, the DOM implementation, and the shape of your data.
This page measures them with `pnpm bench`. Nothing here is a CI gate.

A precise update is not automatically a cheap one. Changing one row of
10,000 is one DOM write (precision), but the work that finds that one write
can still be proportional to the list's length (throughput). The rest of
this page says where that work is, how large it is, and what to do about it.

## What CI asserts

| budget | enforced in |
|---|---|
| reconcile: 1 change in 10k ≤ 100 µs | `packages/core/test/reconcile.perf.test.ts` |
| Mario: 1 view yield, exactly 2 DOM writes in the busiest frame, 0 structural ops | `examples/mario/mario.golden.test.ts` |
| js-framework-benchmark: exact move, insert, write, and listener counts per operation on 1,000 rows | `examples/js-framework-benchmark/bench.test.ts` |
| an idle registry process (a chat room) ≤ 8 KB of heap | `test/room-memory.test.ts` |
| nothing retained after dispose | `packages/core/test/process.leaks.test.ts` |

Only the first budget is a time, and it covers the diff alone. The others are
counts. None of them times the whole path, which is what the rest of this
page does.

## The path one update takes

A process yields a new state. From there:

1. **Construction.** Your code builds the next state immutably, before the
   yield. Replacing one element of an array copies the array (`with`, or a
   spread), which is O(n) pointer copies. Spreading a record copies its keys.
2. **Reconcile.** `reconcile(prev, next)` returns early wherever `prev` and
   `next` are the same object, so shared subtrees cost one identity check.
   For an array it scans the shared prefix and suffix, which is O(n) identity
   checks even when one element changed. A record is walked key by key, over
   both key sets. Two values with no shared identity, such as a snapshot
   freshly parsed from JSON, are compared all the way down, which is
   proportional to the size of the data even when nothing changed.
3. **Waking readers.** The patch is tested against the paths every reader of
   that process recorded. This is O(readers of the process), with each test
   O(ops × path depth). Only readers whose paths the patch touches re-run
   (`docs/internals/tracking.md` has the rules).
4. **Bindings.** A binding that re-runs does its whole body again. The usual
   keyed list, `() => rows().map((row) => tr({ key: row.id }, ...))`, reads
   every row, so a change to any row re-runs it: it rebuilds n vnodes through
   the read-tracking proxies, matches them to the existing rows by key,
   patches each matched row, and swaps each row's fresh closures into its
   existing bindings. That is O(n) work for one changed row.
5. **DOM writes.** Only what differs is written, and survivors that are
   already in order stay put (n − LIS moves). This is the part the budgets
   pin.
6. **The wire, when the process is remote.** The host reconciles, encodes the
   patch as JSON, and sends it. The client decodes and validates it, then
   `applyPatch` copies each container on the ops' paths once per patch, so
   a patch of k ops into an array of n costs O(n + k). The client then
   publishes the result and runs steps 3 to 5 locally.

## Measured

`pnpm bench` runs `bench/run.ts` and prints these tables. The rows have the
js-framework-benchmark shape (a keyed `<tr>` with a class binding on a
selection process, an id cell, and a label cell); the views are in
`bench/views.ts` and the state in `bench/state.ts`. The DOM is happy-dom
under Node, not a browser.

Measured on Node v22.12.0, an Intel Core i7-7820HQ laptop (2.9 GHz, 2017),
Windows 10, happy-dom 20.11.6:

| case | size | local e2e median | p95 | no DOM | construct | reconcile | reconcile share | wire | ops | patch bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sparse edit: one row | 1 row | 53 µs | 115 µs | 18 µs | 1 µs | 1 µs | 2% | 12 µs | 1 | 62 B |
| sparse edit: one row | 1,000 rows | 8.14 ms | 10.2 ms | 57 µs | 5 µs | 6 µs | 0% | 37 µs | 1 | 66 B |
| swap two rows | 1,000 rows | 9.88 ms | 15.2 ms | 21 µs | 5 µs | 9 µs | 0% | 57 µs | 4 | 133 B |
| reverse | 1,000 rows | 29.4 ms | 38.5 ms | 1.67 ms | 6 µs | 349 µs | 1% | 5.57 ms* | 2000 | 53 kB |
| fresh snapshot, equal data | 1,000 rows | 465 µs | 683 µs | 448 µs | 235 µs | 189 µs | 41% | 193 µs | 0 | 36 B |
| fresh snapshot, one row changed | 1,000 rows | 9.55 ms | 12.9 ms | 432 µs | 349 µs | 207 µs | 2% | 221 µs | 1 | 66 B |
| append one row | 1,000 rows | 7.86 ms | 12.1 ms | 44 µs | 7 µs | 5 µs | 0% | 34 µs | 1 | 89 B |
| sparse edit: one row, normalized | 1,000 rows | 340 µs | 948 µs | 95 µs | 3 µs | 86 µs | 25% | 102 µs | 1 | 71 B |
| sparse edit: one row | 10,000 rows | 123 ms | 152 ms | 43 µs | 13 µs | 33 µs | 0% | 78 µs | 1 | 68 B |
| swap two rows | 10,000 rows | 113 ms | 149 ms | 62 µs | 13 µs | 46 µs | 0% | 117 µs | 4 | 137 B |
| reverse | 10,000 rows | 759 ms | 781 ms | 20.6 ms | 20 µs | 5.23 ms | 1% | 67.0 ms* | 20000 | 566 kB |
| fresh snapshot, equal data | 10,000 rows | 5.39 ms | 7.60 ms | 4.85 ms | 3.31 ms | 2.33 ms | 43% | 2.34 ms | 0 | 36 B |
| fresh snapshot, one row changed | 10,000 rows | 128 ms | 208 ms | 5.15 ms | 3.38 ms | 2.56 ms | 2% | 2.17 ms | 1 | 67 B |
| append one row | 10,000 rows | 111 ms | 158 ms | 50 µs | 23 µs | 32 µs | 0% | 77 µs | 1 | 92 B |
| sparse edit: one row, normalized | 10,000 rows | 6.03 ms | 7.53 ms | 817 µs | 13 µs | 833 µs | 14% | 848 µs | 1 | 73 B |
| append a token to a text | 10,000 chars | 18 µs | 24 µs | 7 µs | 0 µs | 1 µs | 4% | 39 µs | 1 | 10 kB |
| append a token to a text | 100,000 chars | 18 µs | 35 µs | 7 µs | 0 µs | 1 µs | 4% | 303 µs | 1 | 100 kB |
| append a token to a chunk list | 10,000 chars | 827 µs | 2.16 ms | 17 µs | 5 µs | 7 µs | 1% | 23 µs | 1 | 73 B |
| append a token to a chunk list | 100,000 chars | 13.0 ms | 18.3 ms | 276 µs | 212 µs | 62 µs | 0% | 278 µs | 1 | 74 B |

\* Re-measured after `applyPatch` began copying each container once per
patch; the rest of the table predates that change, which touched only the
wire column.

| stream | total local e2e | total wire bytes |
| --- | --- | --- |
| 500 rows appended one at a time, from empty | 1290 ms | 43 kB |
| 1,000 rows appended one at a time, from empty | 4610 ms | 86 kB |
| 2,000 five-char tokens streamed into one string | 44.2 ms | 10 MB |
| 5,000 five-char tokens streamed into one string | 121 ms | 63 MB |
| 2,000 five-char tokens streamed into a chunk list | 1039 ms | 145 kB |
| 5,000 five-char tokens streamed into a chunk list | 6573 ms | 364 kB |

| memory (least of 3 trials) | bytes |
| --- | --- |
| 10,000 rows as plain data, per row | 69 |
| the same rows built with plain DOM calls (happy-dom), per row | 23481 |
| a process holding the rows plus the mounted keyed list, per row | 27643 |
| of which the library (bindings, vnodes, bookkeeping), per row | 4162 |
| an idle process (10,000 spawned), each | 6220 |

The columns:

- **local e2e**: wall time from `cast` to the DOM settled, with the list
  mounted: the mailbox, the reducer, reconcile, waking readers, the bindings,
  and the DOM writes. The median and the 95th percentile over at least seven
  timed runs (up to 300, or one second of runs).
- **no DOM**: the same process with nothing mounted. This is the core's
  share: mailbox, reducer, and reconcile, with no readers to wake.
- **construct**: the reducer alone (for a fresh snapshot, the `JSON.parse`).
- **reconcile**: `reconcile(prev, next)` alone, on the same pair of states.
  **reconcile share** is it over local e2e.
- **wire**: what a remote process adds on top of the host's own yield:
  reconcile, encode, decode with validation, and `applyPatch`. The client
  then runs the local path.
- **ops** and **patch bytes**: the patch, and its encoded `yield` frame.

These are one machine's numbers and they move between runs, by as much as 2×
on the slowest rows on this laptop. Compare rows with each other, not with
another machine's.

## Reading the numbers

**Sparse edits.** Changing one row is one text write at every size, and the
core's part is small: 43 µs at 10,000 rows (the no DOM column), of which
reconcile is 33 µs, under 1% of the total. The time goes to step 4. The list
binding re-runs over every row, at roughly 10 µs per row here: 8 ms at 1,000
rows, 123 ms at 10,000. A swap costs the same, for the same reason. A CPU profile of the
10,000-row edit puts most of it in the library's own code (the read-tracking
proxies, rebuilding the vnodes, patching each row, matching keys) and about
a tenth in happy-dom, so expect the same order of magnitude in a browser. The
prefix and suffix scan the diff does is real, but at these sizes it is not
where the time goes.

**Normalized state.** Keeping the rows as `order` plus `byId`, with each
label in its own binding, means an edit to one row does not touch the list
binding at all: it reads only `order`. At 10,000 rows the edit drops from
123 ms to 6 ms. The remaining cost is still O(n), with a smaller constant:
reconcile walks the 10,000 keys of `byId` (833 µs, about 25 times the array
scan's cost per element), and the patch is tested against each of the
10,000 label bindings (step 3). The recipe is below.

**Reorders.** A swap is four field-level ops (the diff is positional) and two
DOM moves. A reverse of 10,000 is 20,000 ops (two per row, one per field).
Locally, a profile puts most of its 759 ms in happy-dom moving 9,999 nodes,
which a browser does much faster; the core's share is the 21 ms in the no DOM
column. Over the wire, the same reverse takes 67 ms to encode, decode, and
apply. It took 295 ms before `applyPatch` learned to copy each container once
per patch instead of once per op; the O(n + k) in step 6.

**Fresh snapshots.** When every value is new (a `JSON.parse` of a server
response), reconcile compares everything. If the data is equal the patch is
empty and nothing downstream runs, so the cost is the parse (3.3 ms) and the
compare (2.3 ms) at 10,000 rows. If one row differs, the patch is still one
op, but the list binding re-runs as in a sparse edit, on top of the compare.

**Appends.** One append costs about what a sparse edit costs, because the
list binding re-runs. Streamed from empty, one row at a time, the total is
quadratic: 500 rows take 1.3 s and 1,000 take 4.6 s.

**Streaming text.** Appending a token to a string is cheap locally (18 µs,
whatever the length): the text binding writes the new string. On the wire,
though, a string is a value, so each patch carries the whole string, and the
bytes sent grow with the square of the length: 5,000 five-character tokens
send 63 MB. Keeping the tokens as an array (`chunks`) makes each patch a
one-token splice (74 bytes) and the whole stream 364 kB. The price is local:
the paragraph's binding walks every chunk on each append, so an append costs
0.8 ms at 2,000 chunks and 13 ms at 20,000.

**Memory.** A row of plain data is 69 bytes. Mounted, most of a row's heap
is DOM nodes, and happy-dom's are far larger than a browser's, so read the
library's share instead: the mounted list minus the same rows built with
plain DOM calls, about 4 KB per row (the row's bindings, its vnodes, and the
sink's bookkeeping). An idle process is about 6 KB, which is what makes
thousands of registry processes per server practical
(`test/room-memory.test.ts` holds a chat room to 8 KB).

## What you can do

**Share what didn't change.** Build the next state with spreads that reuse
every untouched object. Reconcile then stops at identity checks. A deep
clone, or mutate-then-clone, turns every update into a fresh snapshot.

**Normalize big lists that change in place.** When a list is large and its
rows change more often than its order, keep the order and the rows apart and
give each row's changing fields their own bindings:

<!-- ts-prelude
import type { Cast, Proc, Process, VNode } from '@nonchalant/core'
import { a, tbody, td, tr } from '@nonchalant/dom/tags'
-->
```ts
type Row = { id: number; label: string }
type Table = { order: number[]; byId: { [id: string]: Row } }
type TableMsg = Cast<{ type: 'rename'; id: number; label: string }>

const table: Proc<Table, TableMsg, Table> = async function* (self, init) {
  let t = init
  yield t
  for await (const msg of self) {
    switch (msg.type) {
      case 'rename': {
        const row = t.byId[msg.id]
        if (row === undefined) continue
        t = { ...t, byId: { ...t.byId, [msg.id]: { ...row, label: msg.label } } }
        break
      }
    }
    yield t
  }
}

// the list binding reads only `order`; a rename wakes one label binding
function Rows(t: Process<Table, TableMsg>): VNode {
  return tbody({}, () =>
    t().order.map((id) =>
      tr({ key: id },
        td({}, String(id)),
        td({}, a({}, () => t().byId[id]?.label ?? '')))))
}
```

Adding, removing, and reordering rows still re-runs the list binding, which
is what should happen. The measured difference is in the table: the
normalized edit is about 20 times faster at 10,000 rows.

**Send patches, not snapshots.** A remote process already does: the host
diffs, and the client applies the patch to its previous snapshot, so
everything outside the patch keeps its identity on the client. When you
receive whole snapshots from elsewhere (a polling fetch), the patch you
yield is still precise, but each one costs a compare proportional to the
data.

**Pick the text shape by where it streams.** Locally, a string is the cheap
shape. Across the wire, a string resends itself with every token; yielding
`{ chunks: [...chunks, token] }` instead of `{ text: text + token }` sends
one token per patch, but each append then costs the view a walk over every
chunk. The table has both sides of that trade.

**Keep frame-rate state small.** A game loop or a drag yields often; keep
what it yields to what changes per frame, and read the rest from other
processes. Mario's budget (one view yield, two writes a frame) is that
pattern.

A bigger lever is left in the code on purpose. An inverted path index would
make waking readers O(affected) instead of O(readers)
(`docs/internals/tracking.md`). It isn't needed for the CI budgets;
measure with `pnpm bench` before reaching for it.
