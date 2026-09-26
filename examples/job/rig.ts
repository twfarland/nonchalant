// The whole topology, in one tab: a "worker" that runs the job and serves it
// over the wire, a page that reads it through a wire client, a cable between
// them that can be pulled out, and the two things that outlive the worker —
// its journal (the Store) and the destination it writes into.
//
// Nothing in here is special to the browser. The worker half is what a Node
// host would run behind @nonchalant/host; the cable stands in for the network,
// and it can fail in two ways: the client drops off (unplug), or the worker
// dies (kill). Either way the client's view goes stale and keeps its last
// value; on reconnect it looks the job up again and gets a full snapshot.

import { cell, define, registry, spawn } from '@nonchalant/core'
import type { Cast, Process, Proc } from '@nonchalant/core'
import { durable, memoryStore, scheduler } from '@nonchalant/durable'
import type { Store } from '@nonchalant/durable'
import { connect, decodeClient, decodeHost, expose, type Transport, type TransportHandlers } from '@nonchalant/wire'
import { emptyLedger, job, ledger, type Clock, type JobMsg, type JobSchema, type JobState, type LedgerMsg, type LedgerState, type Site } from './job.ts'

export const JOB_ID = 'import'

// ---------- the wire tape ----------

export type Line = { n: number; dir: 'up' | 'down'; text: string }
export type TapeMsg = Cast<{ dir: Line['dir']; data: string }>

const TAPE = 20
const WIDTH = 110

const clip = (text: string): string => (text.length > WIDTH ? `${text.slice(0, WIDTH - 1)}…` : text)
const body = (v: unknown): string => (v === undefined ? '' : ` ${JSON.stringify(v)}`)

/** One wire message as a line a person can read: the op, then what it carries. Decoded with the wire's own codec. */
export function readable(dir: Line['dir'], data: string): string {
  if (dir === 'up') {
    const m = decodeClient(data)
    if (m === null) return clip(data)
    switch (m.op) {
      case 'lookup':
        return clip(`lookup ${m.name}${body(m.args)}`)
      case 'cast':
        return clip(`cast${body(m.msg)}`)
      case 'call':
        return clip(`call #${m.id}${body(m.msg)}`)
      case 'exit':
        return 'exit'
    }
  }
  const m = decodeHost(data)
  if (m === null) return clip(data)
  switch (m.op) {
    case 'yield':
      return clip(`yield${body(m.patch)}`)
    case 'reply':
      return clip(`reply #${m.id}${body(m.value)}`)
    case 'done':
      return 'done'
    case 'raise':
      return clip(`raise${body(m.error)}`)
  }
}

/** The last few messages that crossed the cable, oldest first. */
export const tape: Proc<Line[], TapeMsg, void> = async function* (self) {
  let lines: Line[] = []
  let n = 0
  yield lines
  for await (const msg of self) {
    lines = [...lines.slice(1 - TAPE), { n: ++n, dir: msg.dir, text: readable(msg.dir, msg.data) }]
    yield lines
  }
}

// ---------- the cable ----------

export type CableState = { plugged: boolean; up: boolean }

interface Cable {
  client: Transport
  host: Transport
  /** The client drops off the network, or comes back. */
  plug(on: boolean): void
  /** The worker dies, or has booted and is serving. */
  power(on: boolean): void
}

// Ordered and async, like memoryPair; a message is dropped if the cable is
// down when it would arrive, so nothing sneaks across a partition. Both
// failures look the same from either end: close, and later open.
function cable(onChange: (state: CableState) => void, tap: (dir: Line['dir'], data: string) => void): Cable {
  let plugged = true
  let up = false
  let client: TransportHandlers | null = null
  let host: TransportHandlers | null = null
  const live = (): boolean => plugged && up

  const deliver = (dir: Line['dir'], data: string): void => {
    if (!live()) return
    queueMicrotask(() => {
      const to = dir === 'up' ? host : client
      if (!live() || to === null) return
      tap(dir, data)
      to.message(data)
    })
  }

  const change = (next: () => void): void => {
    const was = live()
    next()
    onChange({ plugged, up })
    if (was && !live()) {
      client?.close?.()
      host?.close?.()
    }
    if (!was && live()) {
      host?.open?.()
      client?.open?.()
    }
  }

  const end = (set: (h: TransportHandlers | null) => void, get: () => TransportHandlers | null, dir: Line['dir']): Transport => ({
    send: (data) => deliver(dir, data),
    subscribe: (handlers) => {
      set(handlers)
      if (live()) queueMicrotask(() => handlers.open?.())
      return () => {
        if (get() === handlers) set(null)
      }
    },
  })

  return {
    client: end((h) => (client = h), () => client, 'up'),
    host: end((h) => (host = h), () => host, 'down'),
    plug: (on) => change(() => (plugged = on)),
    power: (on) => change(() => (up = on)),
  }
}

// ---------- the rig ----------

export interface Rig extends Disposable {
  /** The job as the page sees it: over the wire, stale while partitioned. */
  job: Process<JobState | undefined, JobMsg>
  /** The destination, which outlives the worker. */
  ledger: Process<LedgerState, LedgerMsg>
  tape: Process<Line[], TapeMsg>
  cable: Process<CableState, CableState>
  /** The job as the worker sees it (a lookup, so it activates it), or undefined while the worker is down. */
  local(): Process<JobState | undefined, JobMsg> | undefined
  unplug(): void
  plug(): void
  kill(): void
  boot(): void
}

export function rig(clock: Clock, store: Store = memoryStore()): Rig {
  const dest = spawn(ledger, undefined, { initial: emptyLedger })
  const site: Site = { clock, ledger: dest }
  const wireTape = spawn(tape, undefined, { initial: [] })
  const state = cell<CableState>({ plugged: true, up: false })
  const link = cable((s) => state.cast(s), (dir, data) => wireTape.cast({ dir, data }))
  // a record takes about a second; a message unacknowledged for three is presumed abandoned
  const run = durable(job, { store, key: (a: { id: string }) => a.id, now: clock.now, redeliverAfter: 3000 })

  // what dies with the worker: its registry, the processes in it, its scheduler, the host half of the wire
  let worker: { stop(): void; job(): Process<JobState | undefined, JobMsg> } | undefined

  const boot = (): void => {
    if (worker !== undefined) return
    const reg = registry({
      job: define<JobState, JobMsg, { id: string }>((self, args) => run(self, { ...args, site })),
    })
    // Nothing holds the job. A message left unacknowledged by a killed worker
    // makes its key due, and the scheduler wakes it: the job resumes whether or
    // not anybody is watching, and a finished one stays asleep in the store.
    const timers = scheduler({ store, wake: (id) => reg.lookup('job', { id }), interval: 100, now: clock.now })
    // a stable principal, so a retried decision lands on the same record
    const unexpose = expose({ lookup: reg.lookup, principal: 'reader' }, link.host)
    worker = {
      stop: () => {
        timers[Symbol.dispose]()
        unexpose()
        reg.evict('job') // disposal: the signal aborts the write in flight
      },
      job: () => reg.lookup('job', { id: JOB_ID }),
    }
    link.power(true)
  }

  const kill = (): void => {
    if (worker === undefined) return
    link.power(false)
    worker.stop()
    worker = undefined
  }

  const client = connect<JobSchema>(link.client)
  const remote = client.lookup('job', { id: JOB_ID })
  boot()

  return {
    job: remote,
    ledger: dest,
    tape: wireTape,
    cable: state,
    local: () => worker?.job(),
    unplug: () => link.plug(false),
    plug: () => link.plug(true),
    kill,
    boot,
    [Symbol.dispose]: () => {
      kill()
      client.close()
      dest[Symbol.dispose]()
      wireTape[Symbol.dispose]()
      state[Symbol.dispose]()
    },
  }
}
