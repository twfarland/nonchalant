// Reply bookkeeping for `call`: every in-flight call is registered under its
// message object (the `{ ...msg, reply }` the mailbox carries), so whichever
// path removes that object from the mailbox can reject its caller.

import type { Fifo } from './mailbox.ts'

export type PendingCalls = Map<object, (err: unknown) => void>

/** Reject every pending call with `err` and forget them all. */
export function rejectAll(pending: PendingCalls, err: unknown): void {
  for (const reject of pending.values()) reject(err)
  pending.clear()
}

/** The mailbox let go of `msg` undelivered; if it is a call, its caller rejects. */
export function rejectDropped(pending: PendingCalls, msg: unknown): void {
  const reject = pending.get(msg as object)
  if (reject !== undefined) {
    pending.delete(msg as object)
    reject(new Error('nonchalant: call dropped — mailbox overflow or process ended'))
  }
}

/** Remove queued calls from `queue`, keeping casts in order. The calls stay
 * pending: a crash rejects them with its own error, and a restarted instance
 * never sees them. */
export function retainCasts<In>(queue: Fifo<In>, pending: PendingCalls): void {
  for (const msg of queue.drain()) {
    if (!pending.has(msg as object)) queue.push(msg)
  }
}
