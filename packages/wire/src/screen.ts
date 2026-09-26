// Host-side message screening, as one pure pipeline: shape check, then the
// gateway's admit, then principal namespacing. One malformed message from one
// client must not be able to crash a process every other client is watching.

import type { Json } from '@nonchalant/core'
import type { Exposable } from './host.ts'
import { isRecord } from './protocol.ts'

/** An error as the wire carries it: its message, and the id of the call it rejects if any. */
export const errorJson = (e: unknown, id?: number): Json => {
  const base: { message: string; id?: number } = { message: e instanceof Error ? e.message : String(e) }
  if (id !== undefined) base.id = id
  return base as Json
}

/**
 * A string `callId` moved into `principal`'s namespace. The JSON pair is
 * injective: no principal and id can recombine into another's.
 */
export const namespaceCallId = (msg: Json, principal: string | undefined): Json =>
  principal !== undefined && isRecord(msg) && typeof msg['callId'] === 'string'
    ? { ...msg, callId: JSON.stringify([principal, msg['callId']]) }
    : msg

/** The message to deliver to the process `gate` looked up under `name`, or an Error saying why not. */
export function screen(msg: unknown, name: string, gate: Pick<Exposable, 'admit' | 'principal'>): Json | Error {
  if (!isRecord(msg) || typeof msg['type'] !== 'string') return new Error('invalid message: expected an object with a string type')
  let admitted: Json | undefined = msg as Json
  try {
    if (gate.admit !== undefined) admitted = gate.admit(name, msg as { type: string } & { [key: string]: Json })
  } catch {
    admitted = undefined
  }
  if (admitted === undefined) return new Error('message refused')
  return namespaceCallId(admitted, gate.principal)
}
