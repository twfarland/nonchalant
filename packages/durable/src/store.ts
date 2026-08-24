// The port. `durable()` knows nothing about storage beyond these eight
// methods, and storage knows nothing about processes — an adapter is a plain
// object, written wherever the storage lives (this repo ships the in-memory
// one; a Postgres or SQLite adapter belongs in whatever repo owns that
// dependency).
//
// One key is one process instance: its acknowledged state, the log of messages
// it has been sent, the effects completed inside the message it is handling
// right now, and the answers it has already given to calls.
//
// The single ordering rule an adapter must honour: `commit` writes the snapshot
// and the cursor together, or writes neither. Everything else follows from
// that — a torn commit is the one failure the wrapper cannot recover from,
// because it is what tells "this message was handled" from "this message must
// be handled again".

import type { Json } from '@nonchalant/core'

export interface Loaded {
  /** The last acknowledged state, or undefined if this key has never committed. */
  snapshot: Json | undefined
  /** The sequence number of the last acknowledged message; 0 before any. */
  cursor: number
}

export interface Logged {
  seq: number
  msg: Json
  /** Set when the message is a call: its idempotency key. */
  callId?: string
}

export interface StepRecord {
  index: number
  name: string
  result: Json
}

export interface Store {
  load(key: string): Promise<Loaded | undefined>
  /** Journal an inbound message before it is handled; returns its sequence number. */
  append(key: string, msg: Json, callId?: string): Promise<number>
  /** Messages after `cursor`, in order — what a restart must replay. */
  pending(key: string, cursor: number): Promise<Logged[]>
  /** Record one completed effect of the message at `seq`. */
  putStep(key: string, seq: number, index: number, name: string, result: Json): Promise<void>
  /** Effects already completed for that message. */
  steps(key: string, seq: number): Promise<StepRecord[]>
  /** Acknowledge: snapshot and cursor land together, and that message's steps are dropped. */
  commit(key: string, snapshot: Json, cursor: number): Promise<void>
  /**
   * The answer this process already gave to that call, if it gave one. Answers
   * outlive the message that produced them — they are what makes a retried
   * call return rather than run again — so an adapter with real storage needs a
   * retention window for them.
   */
  result(key: string, callId: string): Promise<Json | undefined>
  putResult(key: string, callId: string, value: Json): Promise<void>
}
