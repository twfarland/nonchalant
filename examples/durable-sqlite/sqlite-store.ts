// A durable Store on SQLite, through Node's built-in `node:sqlite` — no npm
// driver. It lives in examples/ rather than packages/ because a real adapter
// belongs with its driver; this one exists to show the port mapped onto real
// storage, and it certifies against @nonchalant/durable/conformance like any
// external adapter would.
//
// Every write is one `BEGIN IMMEDIATE` transaction that first compares the
// key's stored epoch with the one the writer holds: IMMEDIATE takes the write
// lock up front, so between the compare and the write no other connection —
// in this process or another one on the same file — can claim the key.
// DatabaseSync is synchronous, so each method runs start to finish in one turn.

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { Json } from '@nonchalant/core'
import { Fenced } from '@nonchalant/durable'
import type { DeadLetter, Logged, StepRecord, Store } from '@nonchalant/durable'

export interface SqliteStore extends Store {
  /** The messages this key gave up on, oldest first. */
  dead(key: string): DeadLetter[]
  /** Forget answers committed before `before`: run it on a schedule as the retention window. */
  prune(before: number): void
}

type Row = Record<string, SQLOutputValue>

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS instances (
    key TEXT PRIMARY KEY,
    snapshot TEXT,                 -- JSON; NULL when never committed
    version INTEGER NOT NULL DEFAULT 0,
    cursor INTEGER NOT NULL DEFAULT 0,
    epoch INTEGER NOT NULL DEFAULT 0,
    next INTEGER NOT NULL DEFAULT 1,
    wake_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS instances_wake ON instances (wake_at) WHERE wake_at IS NOT NULL;
  CREATE TABLE IF NOT EXISTS log (
    key TEXT NOT NULL, seq INTEGER NOT NULL, msg TEXT NOT NULL, call_id TEXT,
    PRIMARY KEY (key, seq)
  );
  CREATE TABLE IF NOT EXISTS steps (
    id INTEGER PRIMARY KEY, key TEXT NOT NULL, seq INTEGER NOT NULL,
    idx INTEGER NOT NULL, name TEXT NOT NULL, result TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS steps_by_message ON steps (key, seq);
  CREATE TABLE IF NOT EXISTS results (
    key TEXT NOT NULL, call_id TEXT NOT NULL, answer TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (key, call_id)
  );
  CREATE TABLE IF NOT EXISTS dead (
    id INTEGER PRIMARY KEY, key TEXT NOT NULL, seq INTEGER NOT NULL,
    msg TEXT NOT NULL, call_id TEXT, error TEXT NOT NULL
  );
`

const logged = (row: Row): Logged => {
  const seq = Number(row['seq'])
  const msg = JSON.parse(String(row['msg'])) as Json
  return row['call_id'] === null ? { seq, msg } : { seq, msg, callId: String(row['call_id']) }
}

/** A Store over an open database. `now` stamps committed answers for `prune`. */
export function sqliteStore(db: DatabaseSync, now: () => number = Date.now): SqliteStore {
  db.exec('PRAGMA busy_timeout = 5000') // another process holding the write lock: wait, do not fail
  db.exec(SCHEMA)

  const q = {
    claim: db.prepare('INSERT INTO instances (key, epoch) VALUES (?, 1) ON CONFLICT (key) DO UPDATE SET epoch = epoch + 1 RETURNING *'),
    epoch: db.prepare('SELECT epoch FROM instances WHERE key = ?'),
    bump: db.prepare('UPDATE instances SET next = next + 1 WHERE key = ? RETURNING next - 1 AS seq'),
    append: db.prepare('INSERT INTO log (key, seq, msg, call_id) VALUES (?, ?, ?, ?)'),
    pending: db.prepare('SELECT seq, msg, call_id FROM log WHERE key = ? AND seq > ? ORDER BY seq'),
    putStep: db.prepare('INSERT INTO steps (key, seq, idx, name, result) VALUES (?, ?, ?, ?, ?)'),
    wake: db.prepare('UPDATE instances SET wake_at = ? WHERE key = ?'),
    steps: db.prepare('SELECT idx, name, result FROM steps WHERE key = ? AND seq = ? ORDER BY id'),
    commit: db.prepare('UPDATE instances SET snapshot = ?, version = ?, cursor = ?, wake_at = NULL WHERE key = ?'),
    answer: db.prepare('INSERT OR REPLACE INTO results (key, call_id, answer, at) VALUES (?, ?, ?, ?)'),
    bury: db.prepare('INSERT INTO dead (key, seq, msg, call_id, error) VALUES (?, ?, ?, ?, ?)'),
    trimLog: db.prepare('DELETE FROM log WHERE key = ? AND seq <= ?'),
    trimSteps: db.prepare('DELETE FROM steps WHERE key = ? AND seq <= ?'),
    result: db.prepare('SELECT answer FROM results WHERE key = ? AND call_id = ?'),
    due: db.prepare('SELECT key FROM instances WHERE wake_at <= ? ORDER BY wake_at, key LIMIT ?'),
    dead: db.prepare('SELECT seq, msg, call_id, error FROM dead WHERE key = ? ORDER BY id'),
    prune: db.prepare('DELETE FROM results WHERE at < ?'),
  }

  const transaction = <R>(body: () => R): R => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      db.exec('COMMIT')
      return result
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  /** A write under `epoch`: refused with Fenced, changing nothing, unless it is still the key's. */
  const owned = <R>(key: string, epoch: number, body: () => R): Promise<R> =>
    new Promise((resolve) => resolve(transaction(() => {
      const row = q.epoch.get(key)
      if (row === undefined || Number(row['epoch']) !== epoch) throw new Fenced(key)
      return body()
    })))

  const read = <R>(body: () => R): Promise<R> => new Promise((resolve) => resolve(body()))

  return {
    load: (key) => read(() => transaction(() => {
      const row = q.claim.get(key) as Row
      return {
        snapshot: row['snapshot'] === null ? undefined : (JSON.parse(String(row['snapshot'])) as Json),
        version: Number(row['version']),
        cursor: Number(row['cursor']),
        epoch: Number(row['epoch']),
      }
    })),

    append: (key, epoch, msg, callId) => owned(key, epoch, () => {
      const seq = Number((q.bump.get(key) as Row)['seq'])
      q.append.run(key, seq, JSON.stringify(msg), callId ?? null)
      return seq
    }),

    pending: (key, cursor) => read(() => q.pending.all(key, cursor).map(logged)),

    putStep: (key, epoch, seq, index, name, result, wakeAt) => owned(key, epoch, () => {
      q.putStep.run(key, seq, index, name, JSON.stringify(result))
      if (wakeAt !== undefined) q.wake.run(wakeAt, key)
    }),

    steps: (key, seq) => read(() => q.steps.all(key, seq).map((row): StepRecord => ({
      index: Number(row['idx']),
      name: String(row['name']),
      result: JSON.parse(String(row['result'])) as Json,
    }))),

    commit: (key, epoch, c) => owned(key, epoch, () => {
      q.commit.run(c.snapshot === undefined ? null : JSON.stringify(c.snapshot), c.version, c.cursor, key)
      const at = now()
      for (const [callId, answer] of c.results) q.answer.run(key, callId, JSON.stringify(answer), at)
      if (c.dead !== undefined) q.bury.run(key, c.dead.seq, JSON.stringify(c.dead.msg), c.dead.callId ?? null, c.dead.error)
      q.trimLog.run(key, c.cursor)
      q.trimSteps.run(key, c.cursor)
    }),

    result: (key, callId) => read(() => {
      const row = q.result.get(key, callId)
      return row === undefined ? undefined : (JSON.parse(String(row['answer'])) as Json)
    }),

    due: (at, until, limit) => read(() => transaction(() => {
      const keys = q.due.all(at, limit).map((row) => String(row['key']))
      for (const key of keys) q.wake.run(until, key)
      return keys
    })),

    dead: (key) => q.dead.all(key).map((row) => ({ ...logged(row), error: String(row['error']) })),

    prune: (before) => {
      q.prune.run(before)
    },
  }
}
