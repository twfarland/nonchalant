// The failure semantics the job demo claims, with exact counts. No DOM, no
// real time: the clock is an argument and moves only when a test moves it, so
// "kill it while record 4 is being written" is a line of code, not a race.

import { describe, it, expect } from 'vitest'
import { spawn } from '@nonchalant/core'
import type { Process } from '@nonchalant/core'
import { durable, memoryStore } from '@nonchalant/durable'
import type { Store } from '@nonchalant/durable'
import {
  RECORDS, emptyLedger, job, ledger, refOf, tallyOf,
  type Clock, type JobMsg, type JobState, type LedgerMsg, type LedgerState,
} from './job.ts'
import { JOB_ID, readable, rig } from './rig.ts'

// ---------- a clock the test turns by hand ----------

interface ManualClock extends Clock {
  /** Sleeps currently waiting. */
  waiting(): number
  /** Move to the earliest deadline and wake everything due. */
  next(): void
  /** Move `ms` forward, waking everything due by then. */
  advance(ms: number): void
}

function manualClock(): ManualClock {
  let now = 0
  let timers: { at: number; wake: () => void }[] = []
  const wakeDue = (): void => {
    const due = timers.filter((t) => t.at <= now)
    timers = timers.filter((t) => t.at > now)
    for (const t of due) t.wake()
  }
  return {
    now: () => now,
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        signal.throwIfAborted()
        const timer = {
          at: now + ms,
          wake: () => {
            signal.removeEventListener('abort', onAbort)
            resolve()
          },
        }
        const onAbort = (): void => {
          timers = timers.filter((t) => t !== timer)
          reject(signal.reason)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        timers.push(timer)
      }),
    waiting: () => timers.length,
    next: () => {
      now = Math.min(...timers.map((t) => t.at))
      wakeDue()
    },
    advance: (ms) => {
      now += ms
      wakeDue()
    },
  }
}

const until = async (ready: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 2000 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 1))
  if (!ready()) throw new Error(`never reached: ${what}`)
}

// ---------- the world outside the worker ----------

type Job = Process<JobState | undefined, JobMsg>

interface World {
  store: Store
  clock: ManualClock
  ledger: Process<LedgerState, LedgerMsg>
  /** Activate the job on a fresh "worker": the same store, the same destination. */
  start(): Job
}

function world(store: Store = memoryStore()): World {
  const clock = manualClock()
  const dest = spawn(ledger, undefined, { initial: emptyLedger })
  const run = durable(job, { store, key: (a: { id: string }) => a.id })
  return { store, clock, ledger: dest, start: () => spawn(run, { id: JOB_ID, site: { clock, ledger: dest } }) }
}

const statusOf = (p: Job, i: number): string | undefined => p()?.items[i]?.status

/** Let record `i` finish: its work, then the answer travelling back. */
async function finish(w: World, p: Job, i: number): Promise<void> {
  await until(() => statusOf(p, i) === 'writing' && w.clock.waiting() === 1, `record ${i} writing`)
  w.clock.next() // the work
  await until(() => w.clock.waiting() === 1 && tallyOf(w.ledger(), refOf(1, RECORDS[i]!)).written === 1, `record ${i} written`)
  w.clock.next() // the answer
  await until(() => statusOf(p, i) === 'written', `record ${i} recorded`)
}

const tallies = (w: World): { ran: number; written: number; deduped: number }[] =>
  RECORDS.map((id) => tallyOf(w.ledger(), refOf(1, id)))

// ---------- the job ----------

describe('the job', () => {
  it('writes each record once, and parks at the gate before the first overwrite', async () => {
    const w = world()
    const p = w.start()
    p.cast({ type: 'start' })
    for (let i = 0; i < 6; i++) await finish(w, p, i)

    await until(() => p()?.status === 'waiting', 'the gate')
    expect(w.clock.waiting()).toBe(0) // nothing runs while it waits
    expect(p()!.at).toBe(6)

    const decision = await p.call({ type: 'decide', ok: true, callId: 'gate-1' })
    expect(decision).toStrictEqual({ ok: true, accepted: true })
    for (let i = 6; i < 12; i++) await finish(w, p, i)

    await until(() => p()?.status === 'done', 'the end')
    expect(tallies(w).every((t) => t.ran === 1 && t.written === 1 && t.deduped === 0)).toBe(true)
    expect(w.ledger().rows).toBe(12)
    p[Symbol.dispose]()
  })

  it('killed while a record is being worked on: that one runs again, nothing else does, and nothing is written twice', async () => {
    const w = world()
    let p = w.start()
    p.cast({ type: 'start' })
    for (let i = 0; i < 3; i++) await finish(w, p, i)
    await until(() => statusOf(p, 3) === 'writing' && w.clock.waiting() === 1, 'record 3 at work')

    p[Symbol.dispose]() // the worker dies mid-work: the sleep aborts, no write was sent
    await until(() => w.clock.waiting() === 0, 'the abort')
    expect(tallyOf(w.ledger(), refOf(1, 'umbrella'))).toStrictEqual({ ran: 1, written: 0, deduped: 0 })

    p = w.start() // a new worker, the same journal
    for (let i = 3; i < 6; i++) await finish(w, p, i)
    await until(() => p()?.status === 'waiting', 'the gate')
    await p.call({ type: 'decide', ok: true, callId: 'gate-1' })
    for (let i = 6; i < 12; i++) await finish(w, p, i)
    await until(() => p()?.status === 'done', 'the end')

    const ran = tallies(w).map((t) => t.ran)
    expect(ran).toStrictEqual([1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1]) // records 0–2 came from the journal
    expect(tallies(w).map((t) => t.written)).toStrictEqual(Array(12).fill(1))
    expect(w.ledger().rows).toBe(12)
    p[Symbol.dispose]()
  })

  it('killed after the write landed but before its answer did: the step runs again under the same key, and the destination dedupes it', async () => {
    const w = world()
    let p = w.start()
    p.cast({ type: 'start' })
    for (let i = 0; i < 3; i++) await finish(w, p, i)
    await until(() => statusOf(p, 3) === 'writing' && w.clock.waiting() === 1, 'record 3 at work')
    w.clock.next() // the work is done and the write lands …
    await until(() => tallyOf(w.ledger(), refOf(1, 'umbrella')).written === 1 && w.clock.waiting() === 1, 'the write')
    const first = w.ledger().applied
    p[Symbol.dispose]() // … and the worker dies before the answer reaches the journal
    await until(() => w.clock.waiting() === 0, 'the abort')

    p = w.start()
    await finish(w, p, 3)
    expect(tallyOf(w.ledger(), refOf(1, 'umbrella'))).toStrictEqual({ ran: 2, written: 1, deduped: 1 })
    expect(w.ledger().applied).toStrictEqual(first) // the same key both times: `import#seq#index` is stable across replays
    expect(p()!.items[3]!.key).toBe(Object.keys(first)[3])
    expect(p()!.items[3]!.key).toMatch(/^import#\d+#0$/)
    expect(w.ledger().rows).toBe(4)
    p[Symbol.dispose]()
  })

  it('a pending approval survives a kill, and a retried decision gets the recorded answer', async () => {
    const w = world()
    let p = w.start()
    p.cast({ type: 'start' })
    for (let i = 0; i < 6; i++) await finish(w, p, i)
    await until(() => p()?.status === 'waiting', 'the gate')

    p[Symbol.dispose]()
    p = w.start()
    await until(() => p()?.status === 'waiting', 'the gate, restored')
    expect(p()!.items.slice(0, 6).map((item) => item.status)).toStrictEqual(Array(6).fill('written'))
    expect(w.clock.waiting()).toBe(0)

    expect(await p.call({ type: 'decide', ok: false, callId: 'gate-1' })).toStrictEqual({ ok: false, accepted: true })
    // the same id again, even with the opposite answer: the record wins, nothing moves
    expect(await p.call({ type: 'decide', ok: true, callId: 'gate-1' })).toStrictEqual({ ok: false, accepted: true })
    for (let i = 9; i < 12; i++) await finish(w, p, i)
    await until(() => p()?.status === 'done', 'the end')

    expect(p()!.items.map((item) => item.status)).toStrictEqual([
      ...Array(6).fill('written'), 'skipped', 'skipped', 'skipped', 'written', 'written', 'written',
    ])
    expect(tallies(w).map((t) => t.ran)).toStrictEqual([1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1])
    p[Symbol.dispose]()
  })

  it('cancel lets the record in flight finish, and starts no other', async () => {
    const w = world()
    const p = w.start()
    p.cast({ type: 'start' })
    for (let i = 0; i < 2; i++) await finish(w, p, i)
    await until(() => statusOf(p, 2) === 'writing' && w.clock.waiting() === 1, 'record 2 at work')

    p.cast({ type: 'cancel' }) // queued behind the record in flight
    w.clock.next()
    await until(() => w.clock.waiting() === 1, 'the answer on its way')
    w.clock.next()
    await until(() => p()?.status === 'cancelled', 'the cancel')

    expect(p()!.items.map((item) => item.status)).toStrictEqual([
      'written', 'written', 'written', ...Array(9).fill('queued'),
    ])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(w.clock.waiting()).toBe(0) // nothing was started after it
    expect(tallies(w).map((t) => t.ran)).toStrictEqual([1, 1, 1, ...Array(9).fill(0)])
    p[Symbol.dispose]()
  })

  it('publishes a state before committing it: a reader can see a record written that a kill then takes back, and the replay writes nothing twice', async () => {
    const inner = memoryStore()
    let hold = false
    // a store whose commits can be held back, so the kill lands in the gap
    // between a yield and the next take (which is when the commit happens)
    const store: Store = { ...inner, commit: (key, epoch, c) => (hold ? new Promise<void>(() => {}) : inner.commit(key, epoch, c)) }
    const w = world(store)
    let p = w.start()
    p.cast({ type: 'start' })
    for (let i = 0; i < 2; i++) await finish(w, p, i)
    await until(() => statusOf(p, 2) === 'writing', 'record 2 taken') // so record 1 has committed

    hold = true
    await finish(w, p, 2)
    expect(statusOf(p, 2)).toBe('written') // a reader saw it written …
    p[Symbol.dispose]() // … and the worker died before that message committed

    const committed = (await inner.load(JOB_ID)).snapshot as JobState
    expect(committed.items[2]!.status).toBe('queued') // … so the journal never agreed
    hold = false

    p = w.start()
    await until(() => statusOf(p, 2) === 'written' && statusOf(p, 3) === 'writing', 'the replay')
    expect(tallyOf(w.ledger(), refOf(1, 'initech'))).toStrictEqual({ ran: 1, written: 1, deduped: 0 }) // the step came from the journal
    p[Symbol.dispose]()
  })
})

// ---------- the wire ----------

describe('the job over the wire', () => {
  it('a disconnected client goes stale and keeps its last value while the job runs on; reconnecting converges', async () => {
    const clock = manualClock()
    const r = rig(clock)
    await until(() => r.job()?.status === 'idle', 'the first snapshot')
    r.job.cast({ type: 'start' })
    await until(() => r.job()?.items[0]?.status === 'writing' && clock.waiting() === 1, 'record 0 at work')

    r.unplug()
    await until(() => r.job.stale, 'the stale flag')
    const seen = r.job()
    for (let i = 0; i < 4; i++) {
      clock.next() // record 0's work and answer, then record 1's
      await until(() => clock.waiting() === 1, 'the next sleep')
    }
    await until(() => r.local()?.()?.items[1]?.status === 'written', 'the worker moving on')
    expect(r.job()).toBe(seen) // nothing crossed

    r.plug()
    await until(() => !r.job.stale, 'the reconnect')
    await until(() => JSON.stringify(r.job()) === JSON.stringify(r.local()?.()), 'convergence')
    expect(r.tape().some((line) => line.dir === 'up' && line.text.startsWith('lookup job'))).toBe(true)
    r[Symbol.dispose]()
  })

  it('a killed worker leaves the client stale; a rebooted one resumes the job from its journal', async () => {
    const clock = manualClock()
    const r = rig(clock)
    await until(() => r.job()?.status === 'idle', 'the first snapshot')
    r.job.cast({ type: 'start' })
    await until(() => r.job()?.items[0]?.status === 'writing' && clock.waiting() === 1, 'record 0 at work')

    r.kill()
    await until(() => r.job.stale && clock.waiting() === 0, 'the worker gone')
    expect(r.local()).toBeUndefined()

    r.boot()
    await until(() => !r.job.stale && clock.waiting() === 1, 'the replay')
    expect(r.job()?.items[0]?.status).toBe('writing')
    expect(tallyOf(r.ledger(), refOf(1, 'acme')).ran).toBe(2) // in flight at the kill: at least once
    r[Symbol.dispose]()
  })

  it('a rebooted worker resumes the job with nobody watching, once the interrupted message is overdue', async () => {
    const clock = manualClock()
    const r = rig(clock)
    await until(() => r.job()?.status === 'idle', 'the first snapshot')
    r.job.cast({ type: 'start' })
    await until(() => r.job()?.items[0]?.status === 'writing' && clock.waiting() === 1, 'record 0 at work')

    r.unplug() // no client will look the job up
    r.kill()
    r.boot()
    await new Promise((resolve) => setTimeout(resolve, 300)) // a few scheduler passes
    expect(tallyOf(r.ledger(), refOf(1, 'acme')).ran).toBe(1) // not overdue yet: still asleep in the store

    clock.advance(3000) // past redeliverAfter from the message's append
    await until(() => clock.waiting() === 1, 'the scheduler waking it')
    expect(tallyOf(r.ledger(), refOf(1, 'acme')).ran).toBe(2)
    expect(r.job.stale).toBe(true) // the page still can't see it: it resumed on its own
    r[Symbol.dispose]()
  })

  it('logs each message as a readable line, decoded with the wire codec', () => {
    expect(readable('up', JSON.stringify({ op: 'cast', ref: 'a:1', msg: { type: 'cancel' } }))).toBe('cast {"type":"cancel"}')
    expect(readable('down', JSON.stringify({ op: 'yield', ref: 'a:1', patch: [['set', '/at', 3]] }))).toBe('yield [["set","/at",3]]')
    expect(readable('up', JSON.stringify({ op: 'call', ref: 'a:1', id: 2, msg: { type: 'decide' } }))).toBe('call #2 {"type":"decide"}')
    expect(readable('down', 'x'.repeat(200))).toHaveLength(110)
  })
})
