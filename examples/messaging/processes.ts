// The processes that face those ports. Two of them, and between them they cover
// most of what a backend does with a broker:
//
//   feed(bus)    — a subscription is a process, so an external stream becomes
//                  ordinary state that a view can bind to
//   worker(queue)— reserve, handle, acknowledge; a dying worker loses its lease
//                  and the job comes back to somebody else
//
// Neither knows which broker it is talking to, because neither imports one.

import type { Json, Proc, Self } from '@nonchalant/core'
import type { Bus, Job, Queue } from './ports.ts'

// ---------- a subscription, as a process ----------

export type Feed = { topic: string; events: string[]; received: number }
export type FeedMsg = { type: 'event'; text: string }

const KEEP = 6

/**
 * Look one of these up by topic and the registry becomes the subscription
 * cache: one subscription per topic however many views want it, and the
 * unsubscribe happens when the last one goes away.
 */
export const feed = (bus: Bus): Proc<Feed, FeedMsg, { topic: string }> =>
  async function* (self: Self<FeedMsg>, { topic }) {
    let events: string[] = []
    let received = 0

    const stop = bus.subscribe(topic, (event) => self.send({ type: 'event', text: String(event) }))
    self.signal.addEventListener('abort', stop, { once: true }) // the disposal is the unsubscribe

    yield { topic, events, received }
    for await (const msg of self) {
      events = [...events.slice(-(KEEP - 1)), msg.text]
      received++
      yield { topic, events, received }
    }
  }

// ---------- a queue worker, as a process ----------

export type WorkerState = {
  name: string
  status: 'idle' | 'working' | 'paused'
  holding: string | null
  done: string[]
  failed: number
}

export type WorkerMsg = { type: 'poll' } | { type: 'pause' } | { type: 'resume' }

export interface WorkerOpts {
  queue: Queue
  /** How long a reservation is ours. Long enough to finish, short enough that a death is noticed. */
  leaseMs: number
  /** Milliseconds between polls when the queue is empty. */
  idleMs: number
  handle: (job: Job, signal: AbortSignal) => Promise<string>
}

// The self-send goes through a timer, not straight into the mailbox: a loop
// that re-sends synchronously resolves in microtasks and the event loop never
// turns again — no timer, no I/O, no pause message would ever be heard.
const soon = (fn: () => void, ms: number): void => {
  setTimeout(fn, ms)
}

export const worker = (opts: WorkerOpts): Proc<WorkerState, WorkerMsg, { name: string }> =>
  async function* (self: Self<WorkerMsg>, { name }) {
    let status: WorkerState['status'] = 'idle'
    let holding: string | null = null
    let done: string[] = []
    let failed = 0
    const state = (): WorkerState => ({ name, status, holding, done: [...done], failed })

    soon(() => self.send({ type: 'poll' }), 0)
    yield state()

    for await (const msg of self) {
      if (msg.type === 'pause') {
        if (status === 'paused') continue // no state change, no yield
        status = 'paused'
      } else if (msg.type === 'resume') {
        if (status !== 'paused') continue
        status = 'idle'
        soon(() => self.send({ type: 'poll' }), 0)
      } else {
        if (status === 'paused') continue
        const job = await opts.queue.reserve(opts.leaseMs)
        if (job === undefined) {
          soon(() => self.send({ type: 'poll' }), opts.idleMs)
          if (status === 'idle') continue // nothing happened worth publishing
          status = 'idle'
          holding = null
          yield state()
          continue
        }

        // holding a lease: if this process dies here, the lease expires and
        // somebody else gets the job — which is what at-least-once means
        status = 'working'
        holding = job.id
        yield state()

        try {
          const result = await opts.handle(job, self.signal)
          await opts.queue.ack(job.id)
          done = [...done.slice(-5), result]
        } catch {
          await opts.queue.release(job.id) // failed, not died: give it back now
          failed++
        }
        status = 'idle'
        holding = null
        soon(() => self.send({ type: 'poll' }), 0)
      }
      yield state()
    }
  }

/** Publishing is not a process — it is one call on the port. */
export const announce = (bus: Bus, topic: string, event: Json): Promise<void> => bus.publish(topic, event)
