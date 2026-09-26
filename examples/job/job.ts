// A long-running job, as one durable process: import twelve records into a
// destination, one message per record, with a human approval gate before the
// three that would overwrite rows that already exist.
//
// The transaction boundary is one message (docs/server.md). Each record is its
// own `next` message, so each one commits on its own: a restart replays only
// the record that was in flight, and its write is answered from the journal
// if it had landed. The write is the one effect, so it goes through `d.step`,
// which hands it an idempotency key; the destination refuses to apply a key
// twice. Cancel and the approval are messages like any other, so they are
// handled between records, never in the middle of one.
//
// Time and the destination arrive from outside (a `Clock` and a `Site`), which
// is what lets job.test.ts kill it at an exact point.

import type { Call, Cast, Definition, Process, Proc } from '@nonchalant/core'
import type { DurableProc } from '@nonchalant/durable'

// ---------- time ----------

export interface Clock {
  /** The time, in the same milliseconds `sleep` waits. */
  now(): number
  /** Resolve after `ms`, or reject with the signal's reason if it aborts first. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

/** Timers, with every wait multiplied by `scale` (a test can run the page fast). */
export const realClock = (scale = 1): Clock => ({
  now: () => Date.now() / scale,
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted()
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(signal.reason)
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms * scale)
      signal.addEventListener('abort', onAbort, { once: true })
    }),
})

/** How long one record takes to write, and how long the destination's answer takes to come back. */
export const WORK_MS = 700
export const ACK_MS = 250

// ---------- the destination ----------

// The system the job writes into — a database, an API. It lives outside the
// worker, so it survives the worker being killed, and it keeps the counts that
// prove what happened: how often a write was attempted, and how often a row
// was actually written.

export type Receipt = { key: string; row: number }

export type Tally = { ran: number; written: number; deduped: number }

export type LedgerState = {
  /** Per record of each run (`run/id`). */
  tally: Record<string, Tally>
  /** Idempotency key → the receipt it was first answered with. */
  applied: Record<string, Receipt>
  rows: number
  /** The last few things that happened here, numbered. */
  log: { n: number; text: string }[]
}

export type LedgerMsg =
  | Cast<{ type: 'begin'; ref: string }>
  | Call<{ type: 'write'; ref: string; key: string }, Receipt>

const LOG = 6
const none: Tally = { ran: 0, written: 0, deduped: 0 }

export const tallyOf = (ledger: LedgerState | undefined, ref: string): Tally => ledger?.tally[ref] ?? none

const bump = (s: LedgerState, ref: string, change: Partial<Tally>, line: string): LedgerState => {
  const was = tallyOf(s, ref)
  const next: Tally = {
    ran: was.ran + (change.ran ?? 0),
    written: was.written + (change.written ?? 0),
    deduped: was.deduped + (change.deduped ?? 0),
  }
  const n = (s.log.at(-1)?.n ?? 0) + 1
  return { ...s, tally: { ...s.tally, [ref]: next }, log: [...s.log.slice(1 - LOG), { n, text: line }] }
}

export const emptyLedger: LedgerState = { tally: {}, applied: {}, rows: 0, log: [] }

export const ledger: Proc<LedgerState, LedgerMsg, void> = async function* (self) {
  let s = emptyLedger
  yield s
  for await (const msg of self) {
    switch (msg.type) {
      case 'begin':
        s = bump(s, msg.ref, { ran: 1 }, `${msg.ref}: attempt ${tallyOf(s, msg.ref).ran + 1} started`)
        break
      case 'write': {
        const seen = s.applied[msg.key]
        if (seen !== undefined) {
          msg.reply(seen) // the same answer as the first time, and no second row
          s = bump(s, msg.ref, { deduped: 1 }, `${msg.ref}: ${msg.key} already applied, not written again`)
          break
        }
        const receipt: Receipt = { key: msg.key, row: s.rows + 1 }
        msg.reply(receipt)
        s = bump({ ...s, rows: receipt.row, applied: { ...s.applied, [msg.key]: receipt } }, msg.ref, { written: 1 },
          `${msg.ref}: written as row ${receipt.row} under ${msg.key}`)
        break
      }
    }
    yield s
  }
}

/** What the job needs from the world. */
export interface Site {
  clock: Clock
  ledger: Process<LedgerState, LedgerMsg>
}

/** The effect: do the work, write under the key, wait for the answer to travel back. Abortable in both waits. */
export async function upload(site: Site, ref: string, key: string, signal: AbortSignal): Promise<Receipt> {
  site.ledger.cast({ type: 'begin', ref })
  await site.clock.sleep(WORK_MS, signal)
  const receipt = await site.ledger.call({ type: 'write', ref, key })
  await site.clock.sleep(ACK_MS, signal)
  return receipt
}

// ---------- the job's state ----------

export type ItemStatus = 'queued' | 'writing' | 'written' | 'skipped'

export type Item = {
  id: string
  /** A row with this id already exists at the destination: writing it overwrites, which needs approval. */
  overwrites: boolean
  status: ItemStatus
  /** The idempotency key it was written under. */
  key: string | null
}

export type JobStatus = 'idle' | 'running' | 'waiting' | 'cancelled' | 'done'

export type JobState = {
  status: JobStatus
  /** Which run this is; each start is a new one. */
  run: number
  /** The next record to handle. */
  at: number
  items: Item[]
  /** The gate's answer for this run: null until somebody decides. */
  approved: boolean | null
}

export type Decision = { ok: boolean; accepted: boolean }

export type JobMsg =
  | Cast<{ type: 'start' }>
  | Cast<{ type: 'next'; run: number; at: number }> // self-cast: one record per message
  | Cast<{ type: 'cancel' }>
  | Call<{ type: 'decide'; ok: boolean; callId: string }, Decision>

export type JobSchema = { job: Definition<JobState, JobMsg, { id: string }> }

export const RECORDS = [
  'acme', 'globex', 'initech', 'umbrella', 'hooli', 'stark',
  'wayne', 'wonka', 'tyrell', 'soylent', 'cyberdyne', 'massive',
]
/** wayne, wonka, and tyrell already exist at the destination. */
const EXISTING = new Set(['wayne', 'wonka', 'tyrell'])

// ---------- pure helpers ----------

export const fresh = (run: number): JobState => ({
  status: 'running',
  run,
  at: 0,
  items: RECORDS.map((id) => ({ id, overwrites: EXISTING.has(id), status: 'queued', key: null })),
  approved: null,
})

/** Before the first start: the records it would import, none started. */
export const idleJob: JobState = { ...fresh(0), status: 'idle' }

export const refOf = (run: number, id: string): string => `${run}/${id}`

/** Record `at` changed; everything else shared. */
export const mark = (s: JobState, at: number, status: ItemStatus, key: string | null = null): JobState => ({
  ...s,
  items: s.items.map((item, i) => (i === at ? { ...item, status, key: key ?? item.key } : item)),
})

/** Past the current record: on to the next, or done after the last. */
export const advance = (s: JobState): JobState =>
  s.at + 1 < s.items.length ? { ...s, at: s.at + 1 } : { ...s, at: s.at + 1, status: 'done' }

export const progress = (s: JobState | undefined): { handled: number; total: number } => ({
  handled: s?.items.filter((item) => item.status === 'written' || item.status === 'skipped').length ?? 0,
  total: s?.items.length ?? RECORDS.length,
})

/** The records the gate is about: every one that would overwrite. */
export const gated = (s: JobState | undefined): string[] => s?.items.filter((item) => item.overwrites).map((item) => item.id) ?? []

// ---------- the process ----------

export type JobArgs = { id: string; site: Site }

export const job: DurableProc<JobState, JobMsg, JobArgs> = async function* (self, { site }, d) {
  let s: JobState = d.restored ?? idleJob // the last committed state, not the last one anybody saw
  yield s

  for await (const msg of self) {
    switch (msg.type) {
      case 'start':
        if (s.status === 'running' || s.status === 'waiting') continue
        s = fresh(s.run + 1)
        self.cast({ type: 'next', run: s.run, at: 0 })
        break

      case 'cancel':
        if (s.status !== 'running' && s.status !== 'waiting') continue
        s = { ...s, status: 'cancelled' }
        break

      case 'decide':
        if (s.status !== 'waiting') {
          msg.reply({ ok: msg.ok, accepted: false })
          continue
        }
        s = { ...s, status: 'running', approved: msg.ok }
        msg.reply({ ok: msg.ok, accepted: true }) // released once this message commits
        self.cast({ type: 'next', run: s.run, at: s.at })
        break

      case 'next': {
        // a token from a finished run, or one a replay cast a second time
        if (s.status !== 'running' || msg.run !== s.run || msg.at !== s.at) continue
        const item = s.items[s.at]
        if (item === undefined) continue
        if (item.overwrites && s.approved === null) {
          s = { ...s, status: 'waiting' } // nothing is cast: the decision resumes the job
          break
        }
        if (item.overwrites && s.approved === false) s = advance(mark(s, s.at, 'skipped'))
        else {
          s = mark(s, s.at, 'writing')
          yield s // published now; committed only when this message is
          const ref = refOf(s.run, item.id)
          const receipt = await d.step(`write ${item.id}`, (key) => upload(site, ref, key, self.signal))
          s = advance(mark(s, s.at, 'written', receipt.key))
        }
        if (s.status === 'running') self.cast({ type: 'next', run: s.run, at: s.at })
        break
      }
    }
    yield s
  }
}
