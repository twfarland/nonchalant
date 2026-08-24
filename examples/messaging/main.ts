// The page: a bus with two topics, a queue with two workers, and a button that
// kills one mid-job so you can watch the lease expire and the work come back.
//
// The adapters are in-memory, so this whole page is a broker as well as a
// client of one — swap `memoryQueue()` for an adapter over SQS or pg-boss and
// nothing below the port changes.

import { cell, define, derive, registry, spawn } from '@nonchalant/core'
import type { Process, Self, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, h2, input, li, span, ul } from '@nonchalant/dom/tags'
import { memoryBus, memoryQueue } from './memory.ts'
import { feed, worker, type Feed, type FeedMsg, type WorkerMsg, type WorkerState } from './processes.ts'
import type { Job, QueueStats } from './ports.ts'

type Worker = Process<WorkerState | undefined, WorkerMsg>

const LEASE = 4_000
const WORK = 1_400

const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

// ---------- the outside world ----------

const bus = memoryBus()
const queue = memoryQueue()

const handle = async (job: Job, signal: AbortSignal): Promise<string> => {
  await delay(WORK, signal) // pretend it is real work; killing the worker aborts it
  await bus.publish('jobs', `${job.id} finished (attempt ${job.attempts})`)
  return `${job.id}: ${String(job.body)}`
}

// ---------- the processes ----------

const feeds = registry({ feed: define(feed(bus)) })
const crew = registry({ worker: define(worker({ queue, leaseMs: LEASE, idleMs: 250, handle })) })

const lives = { w1: cell(0), w2: cell(0) }
const workerAt = (name: 'w1' | 'w2'): Process<Worker> =>
  derive<Worker>(() => {
    void lives[name]()
    return crew.lookup('worker', { name }) as Worker
  })
const workers = { w1: workerAt('w1'), w2: workerAt('w2') }

const kill = (name: 'w1' | 'w2') => (): void => {
  crew.evict('worker', { name })
  lives[name].cast(lives[name]() + 1)
}

// A port does not publish changes, so its numbers are polled — inside a
// process, where the interval has an owner and the abort is the cleanup.
const stats = spawn(async function* (self: Self<QueueStats>) {
  const iv = setInterval(() => {
    void queue.stats().then((s) => self.cast(s))
  }, 200)
  self.signal.addEventListener('abort', () => clearInterval(iv), { once: true })
  for await (const s of self.latest()) yield s
}, undefined, { initial: { waiting: 0, leased: 0, done: 0 } })

const drafted = cell('order 1')
let pushed = 1

// ---------- components ----------

function Publish(): VNode {
  const text = cell('something happened')
  const publish = (topic: string) => (): void => {
    void bus.publish(topic, `${text()} (${new Date().toLocaleTimeString()})`)
  }

  return div({ class: 'row' },
    input({
      type: 'text', size: 26, value: text,
      oninput: (e: Event) => text.cast((e.target as HTMLInputElement).value),
    }),
    button({ onclick: publish('orders') }, 'publish to #orders'),
    button({ onclick: publish('alerts') }, 'publish to #alerts'))
}

function FeedPanel(topic: string): VNode {
  const stream = feeds.lookup('feed', { topic }) as Process<Feed | undefined, FeedMsg>

  return div({ class: 'panel' },
    div({}, span({ class: 'tag' }, `#${topic}`),
      span({ class: 'muted' }, () => `${stream()?.received ?? 0} received`)),
    ul({ class: 'list' }, () =>
      (stream()?.events ?? []).map((event, i) => li({ key: `${i}-${event}` }, event))))
}

function Push(): VNode {
  const push = (): void => {
    void queue.push(drafted().trim() === '' ? `order ${pushed}` : drafted())
    drafted.cast(`order ${++pushed}`) // the next one is already typed for you
  }

  return div({ class: 'row' },
    input({
      type: 'text', size: 16, value: drafted,
      oninput: (e: Event) => drafted.cast((e.target as HTMLInputElement).value),
    }),
    button({ onclick: push }, 'push a job'),
    span({ class: 'muted' }, () =>
      `waiting ${stats().waiting} · leased ${stats().leased} · done ${stats().done}`))
}

function WorkerPanel(name: 'w1' | 'w2'): VNode {
  const at = workers[name]
  const now = (): WorkerState | undefined => at()()

  return div({ class: 'panel' },
    div({},
      span({ class: 'tag' }, name),
      span({ class: () => `status ${now()?.status ?? 'idle'}` }, () => now()?.status ?? 'starting'),
      span({ class: 'muted' }, () => (now()?.holding === null ? '' : ` holding ${now()?.holding ?? ''}`))),
    div({ class: 'row' },
      button({ onclick: () => at().cast({ type: 'pause' }) }, 'pause'),
      button({ onclick: () => at().cast({ type: 'resume' }) }, 'resume'),
      button({ onclick: kill(name) }, 'kill')),
    ul({ class: 'list' }, () =>
      (now()?.done ?? []).map((line, i) => li({ key: `${i}-${line}` }, line))),
    div({ class: 'muted' }, () => `failed: ${now()?.failed ?? 0}`))
}

// ---------- the app ----------

function App(): VNode {
  return div({},
    div({ class: 'card' },
      h2({}, 'A bus'),
      div({ class: 'muted' }, 'Fan-out, no history: a subscriber sees what is published while it listens.'),
      Publish(),
      div({ class: 'panels' }, FeedPanel('orders'), FeedPanel('alerts'), FeedPanel('jobs'))),

    div({ class: 'card' },
      h2({}, 'A queue'),
      div({ class: 'muted' },
        `One worker at a time, ${LEASE / 1000}s leases. Kill a worker while it holds a job and watch the lease expire.`),
      Push(),
      div({ class: 'panels' }, WorkerPanel('w1'), WorkerPanel('w2'))))
}

mount(document.getElementById('app')!, App())
