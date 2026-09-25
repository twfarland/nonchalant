// The port. `durable()` and `scheduler()` know nothing about storage beyond
// these eight methods, and storage knows nothing about processes — an adapter is a plain
// object, written wherever the storage lives (this repo ships the in-memory
// one; a Postgres or SQLite adapter belongs in whatever repo owns that
// dependency).
//
// One key is one process instance: its acknowledged state, the log of messages
// it has been sent, the effects completed inside the message it is handling
// right now, the answers it has already given to calls, the messages it
// gave up on, and the time it next needs waking, if any.
//
// Three rules an adapter must honour:
//
// - `commit` is one transaction: snapshot, version, cursor, answers, and dead
//   letter land together or not at all. A torn commit is the one failure the
//   wrapper cannot recover from, because it is what tells "this message was
//   handled and answered" from "this message must be handled again".
// - Every write is conditional on the epoch `load` handed out. `load` claims
//   the key by raising its epoch; a write carrying an older one must change
//   nothing and reject with `Fenced`. That is what keeps two hosts that both
//   think they own a key from interleaving one log.
// - A key's wake time is set by `putStep` (when given one), cleared by
//   `commit`, and pushed forward by `due` for every key it hands out, in the
//   same operation that reads it: that is what stops two schedulers sharing a
//   store from both waking a key on the same pass.

import type { Json } from '@nonchalant/core'

export interface Loaded {
  /** The last acknowledged state, or undefined if this key has never committed. */
  snapshot: Json | undefined
  /** The version that snapshot was committed under; 0 before any. */
  version: number
  /** The sequence number of the last acknowledged message; 0 before any. */
  cursor: number
  /** This activation's fencing token: greater than every epoch handed out before for this key. */
  epoch: number
}

export interface Logged {
  seq: number
  msg: Json
  /** Set when the message is a call: its idempotency key. */
  callId?: string
}

export interface StepRecord {
  /** The step's position within its message. Negative indices record failed attempts. */
  index: number
  name: string
  result: Json
}

/** A message given up on after too many failed attempts, with the last failure. */
export interface DeadLetter extends Logged {
  error: string
}

export interface Commit {
  snapshot: Json | undefined
  version: number
  /** The message acknowledged; its steps and everything before it in the log may go. */
  cursor: number
  /** Answers given while handling it, as [callId, answer]. */
  results: [string, Json][]
  /** Set when the message at `cursor` is being dead-lettered rather than acknowledged. */
  dead?: DeadLetter
}

/** A write refused because a later `load` of the same key has claimed it. */
export class Fenced extends Error {
  constructor(key: string) {
    super(`nonchalant/durable: '${key}' claimed by a later activation`)
  }
}

export interface Store {
  /** Claim the key: raise its epoch and return it with the acknowledged state. */
  load(key: string): Promise<Loaded>
  /** Journal an inbound message before it is handled; returns its sequence number. */
  append(key: string, epoch: number, msg: Json, callId?: string): Promise<number>
  /** Messages after `cursor`, in order — what a restart must replay. */
  pending(key: string, cursor: number): Promise<Logged[]>
  /**
   * Record one completed effect (or failed attempt) of the message at `seq`.
   * With `wakeAt`, the key also becomes due at that time, replacing any wake
   * it had; without, its wake is left as it was.
   */
  putStep(key: string, epoch: number, seq: number, index: number, name: string, result: Json, wakeAt?: number): Promise<void>
  /** Effects and failed attempts already recorded for that message. */
  steps(key: string, seq: number): Promise<StepRecord[]>
  /** Acknowledge one message, atomically, and clear the key's wake time. */
  commit(key: string, epoch: number, commit: Commit): Promise<void>
  /**
   * The answer this process already gave to that call, if it gave one. Answers
   * outlive the message that produced them — they are what makes a retried
   * call return rather than run again — so an adapter with real storage keeps
   * them for a retention window and forgets them after.
   */
  result(key: string, callId: string): Promise<Json | undefined>
  /**
   * Up to `limit` keys whose wake time is at or before `now`, earliest first.
   * Each key returned has its wake time moved to `until` in the same
   * operation — a lease: another caller does not see it again until then,
   * and if nothing commits it in the meantime it comes due again.
   */
  due(now: number, until: number, limit: number): Promise<string[]>
}
