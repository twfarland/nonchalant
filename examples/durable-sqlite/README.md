# durable-sqlite

A durable `Store` on SQLite, using Node's built-in `node:sqlite` (`DatabaseSync`)
with no npm driver. It is an example, not a package: a real adapter belongs
with its driver. Its purpose is to show the eight-method port mapped onto real
storage, and to certify that mapping the way an external adapter would, by
running `@nonchalant/durable/conformance` against it.

```ts
import { DatabaseSync } from 'node:sqlite'
import { define, registry } from '@nonchalant/core'
import { durable, scheduler } from '@nonchalant/durable'
import type { DurableProc } from '@nonchalant/durable'
import { sqliteStore } from './sqlite-store.ts'

declare const order: DurableProc<{ items: number }, { type: 'add' }, { id: string }>

const store = sqliteStore(new DatabaseSync('orders.db'))
const orders = registry({
  order: define(durable(order, { store, key: (a: { id: string }) => a.id }), { evict: 60_000 }),
})
// wakes orders whose sleeps have run out, even after a restart
const timers = scheduler({ store, wake: (id) => orders.lookup('order', { id }) })
```

How the port maps:

| method | SQL |
|---|---|
| `load` | upsert the `instances` row with `epoch = epoch + 1`, `RETURNING` it |
| `append` | `BEGIN IMMEDIATE`, compare the epoch, take `next`, insert into `log`, `COMMIT` |
| `pending` | `SELECT … FROM log WHERE seq > ? ORDER BY seq` |
| `putStep` | fenced insert into `steps`; with a wake time, set `instances.wake_at` |
| `steps` | `SELECT … FROM steps WHERE seq = ? ORDER BY id` |
| `commit` | fenced: snapshot, version, cursor, `wake_at = NULL`, answers, dead letter, then trim `log` and `steps` — one transaction |
| `result` | `SELECT answer FROM results` |
| `due` | in one transaction, select `wake_at <= now ORDER BY wake_at LIMIT n` and move those rows' `wake_at` to the lease end |

Fencing is `BEGIN IMMEDIATE` plus an epoch compare. `IMMEDIATE` takes the
write lock up front, so no other connection, in this process or another on the
same file, can claim the key between the compare and the write. A stale epoch
throws `Fenced` inside the transaction, which rolls it back.

`dead(key)` and `prune(before)` are the out-of-band extras: listing a key's dead
letters, and the retention sweep for call answers, which you would run on a
timer.

## Tests

`sqlite-store.test.ts` runs the conformance suite against an in-memory
database. It then runs a durable process on a file, disposes it partway
through a message, closes the file, and reopens it. Two things are checked
there: the process resumes without repeating the charge it already made, and a
scheduler on the reopened file wakes a sleep that the crash cut short. The
file is skipped with a reason where `node:sqlite` cannot be imported. On Node
22.12 and earlier it needs `--experimental-sqlite`, which `vitest.config.ts`
passes when the running Node recognises the flag.
