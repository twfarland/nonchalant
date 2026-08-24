// Two ports for the two things every backend eventually talks to: a bus that
// fans events out, and a queue that hands work to exactly one worker at a time.
// Neither interface mentions a process, and no process mentions a broker — the
// adapter is the edge, and `memory.ts` is the only one this repo ships.
//
// The shapes are deliberately the ones the real systems share, so an adapter
// over SQS, Redis Streams, NATS, or pg-boss is a translation rather than a
// redesign.

import type { Json } from '@nonchalant/core'

/**
 * Fan-out. A subscriber gets what is published while it is listening and
 * nothing else — no history, no acknowledgement, no redelivery.
 */
export interface Bus {
  publish(topic: string, event: Json): Promise<void>
  /** Returns the unsubscribe. */
  subscribe(topic: string, onEvent: (event: Json) => void): () => void
}

export interface Job {
  id: string
  body: Json
  /** How many times this job has been handed out, including now. */
  attempts: number
}

export interface QueueStats {
  waiting: number
  leased: number
  done: number
}

/**
 * Work, handed to one worker at a time. `reserve` hides a job for the length of
 * its lease; a worker that dies without acknowledging loses the lease and the
 * job comes back. That is the whole contract, and it is why the queue — not the
 * worker — is where at-least-once lives.
 */
export interface Queue {
  push(body: Json): Promise<string>
  reserve(leaseMs: number): Promise<Job | undefined>
  ack(id: string): Promise<void>
  /** Hand it back early, for a worker that failed rather than died. */
  release(id: string): Promise<void>
  stats(): Promise<QueueStats>
}
