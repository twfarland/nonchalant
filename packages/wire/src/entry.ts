// The client's entry table rows and the pure bookkeeping around them: the
// lookup key a name and args resolve under, the lookup a row re-sends on every
// (re)connect, the call id a raise rejects, and the disconnected cast queue.

import type { Json, Process } from '@nonchalant/core'
import { PROTOCOL, type ClientMsg, type HostMsg } from './protocol.ts'

export interface Call {
  resolve(value: Json | undefined): void
  reject(err: unknown): void
}

export interface Entry {
  ref: string
  key: string
  name: string
  args: Json | undefined
  facade: Process<unknown, unknown>
  /** the pump's original mailbox cast, captured before the facade's cast is overridden */
  deliver(msg: HostMsg): void
  calls: Map<number, Call>
  queued: Json[]
  dead: boolean
}

/** Casts retained per ref while disconnected; past this the oldest is dropped. */
export const CAST_QUEUE = 64

const canon = (v: unknown): unknown => {
  if (typeof v !== 'object' || v === null) return v
  if (Array.isArray(v)) return v.map(canon)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v).sort()) out[k] = canon((v as Record<string, unknown>)[k])
  return out
}

/** The table key for a lookup: args equal up to key order share one entry, as in a local registry. */
export const entryKey = (name: string, args: Json | undefined): string =>
  name + '\0' + (args === undefined ? '' : JSON.stringify(canon(args)))

export const lookupMsg = (entry: Pick<Entry, 'ref' | 'name' | 'args'>): ClientMsg =>
  entry.args === undefined
    ? { op: 'lookup', ref: entry.ref, name: entry.name, v: PROTOCOL }
    : { op: 'lookup', ref: entry.ref, name: entry.name, v: PROTOCOL, args: entry.args }

/** The pending call a raise rejects, if its error carries an id; otherwise the raise is process-level. */
export const raisedCallId = (err: Json): number | undefined =>
  typeof err === 'object' && err !== null && !Array.isArray(err) && typeof err['id'] === 'number' ? err['id'] : undefined

/** `queue` with `msg` appended, keeping the newest `cap`. */
export const enqueue = (queue: readonly Json[], msg: Json, cap = CAST_QUEUE): Json[] =>
  queue.length < cap ? [...queue, msg] : [...queue.slice(queue.length - cap + 1), msg]
