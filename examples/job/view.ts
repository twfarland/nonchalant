// The page's half: everything here reads the job through the wire client, the
// way it would read a job on a server. The view never learns which side of a
// partition it is on except through `stale`.

import { cell } from '@nonchalant/core'
import type { Process, VNode } from '@nonchalant/core'
import { button, div, li, span, strong, ul } from '@nonchalant/dom/tags'
import { gated, progress, refOf, tallyOf, type Item, type JobMsg, type JobState, type LedgerMsg, type LedgerState } from './job.ts'
import type { CableState, Line, Rig, TapeMsg } from './rig.ts'

type Job = Process<JobState | undefined, JobMsg>
type Ledger = Process<LedgerState, LedgerMsg>

const active = (s: JobState | undefined): boolean => s?.status === 'running' || s?.status === 'waiting'

// ---------- components ----------

function Controls(job: Job): VNode {
  const bar = (): string => {
    const { handled, total } = progress(job())
    return `width: ${total === 0 ? 0 : Math.round((handled / total) * 100)}%`
  }
  return div({ class: 'stack' },
    div({ class: 'row' },
      button({ onclick: () => job.cast({ type: 'start' }), disabled: () => active(job()) || job() === undefined }, 'start import'),
      // a cast made while partitioned is queued by the client and sent after the reconnect
      button({ onclick: () => job.cast({ type: 'cancel' }), disabled: () => !active(job()) }, 'cancel'),
      span({ class: 'job-state' }, () => {
        const s = job()
        const { handled, total } = progress(s)
        return s === undefined ? 'connecting…' : `${s.status} · ${handled} of ${total}`
      })),
    div({ class: 'job-bar' }, div({ style: bar })))
}

// the gate exists only while the job is waiting on somebody
function Gate(job: Job): () => VNode | null {
  const notice = cell('')
  const decide = (ok: boolean) => (): void => {
    const run = job()?.run ?? 0
    notice.cast('')
    // the callId names the decision, not the click: a retry gets the recorded answer
    job.call({ type: 'decide', ok, callId: `gate-${run}` }).catch((e: unknown) =>
      notice.cast(`not sent: ${e instanceof Error ? e.message : String(e)}`))
  }
  return () => {
    if (job()?.status !== 'waiting') return null
    const names = gated(job())
    return div({ class: 'gate' },
      div({}, strong({}, names.join(', ')), ` already exist at the destination. Writing them overwrites ${names.length} rows.`),
      div({ class: 'row' },
        button({ onclick: decide(true), disabled: () => job.stale }, 'approve'),
        button({ onclick: decide(false), disabled: () => job.stale }, 'skip them'),
        span({ class: 'muted' }, notice)))
  }
}

function Record(item: Item, run: number, ledger: Ledger): VNode {
  const ref = refOf(run, item.id)
  return li({ key: item.id, class: `job-rec ${item.status}` },
    span({ class: 'job-name' }, item.id),
    span({ class: 'job-status' }, item.status),
    span({ class: 'job-tally' }, () => {
      const t = tallyOf(ledger(), ref)
      if (t.ran === 0) return ''
      return `ran ${t.ran}× · wrote ${t.written}×${t.deduped > 0 ? ` · deduped ${t.deduped}×` : ''}`
    }))
}

function Records(job: Job, ledger: Ledger): VNode {
  return ul({ class: 'job-recs' }, () => {
    const s = job()
    return (s?.items ?? []).map((item) => Record(item, s?.run ?? 0, ledger))
  })
}

function Machine(r: Rig, cable: Process<CableState, CableState>): VNode {
  return div({ class: 'row' },
    button({ onclick: () => (cable().plugged ? r.unplug() : r.plug()) },
      () => (cable().plugged ? 'disconnect client' : 'reconnect client')),
    button({ onclick: () => (cable().up ? r.kill() : r.boot()) },
      () => (cable().up ? 'kill worker' : 'restart worker')),
    span({ class: () => `job-flag${r.job.stale ? ' stale' : ''}` },
      () => (r.job.stale ? 'stale: showing the last state received' : 'live')))
}

function Tape(tape: Process<Line[], TapeMsg>): VNode {
  return ul({ class: 'job-tape' }, () =>
    tape().map((line) =>
      li({ key: line.n, class: line.dir },
        span({ class: 'job-dir' }, line.dir === 'up' ? 'page → worker' : 'worker → page'),
        span({}, line.text))))
}

function Destination(ledger: Ledger): VNode {
  return ul({ class: 'job-tape' }, () =>
    ledger().log.map((line) => li({ key: line.n }, span({}, line.text))))
}

// ---------- the app ----------

export function JobApp(r: Rig): VNode {
  return div({ class: 'stack job' },
    Controls(r.job),
    Gate(r.job),
    Records(r.job, r.ledger),
    Machine(r, r.cable),
    div({ class: 'job-label' }, 'on the wire, newest last'),
    Tape(r.tape),
    div({ class: 'job-label' }, 'at the destination'),
    Destination(r.ledger))
}
