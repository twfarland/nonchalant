// The effect queue. Notified effects wait here until a flush drains them.
// Scheduling differs from upstream alien-signals: writes never flush
// synchronously — a drain is scheduled on the microtask queue (one per
// burst), and drain() runs synchronously on demand. `run` is passed in rather
// than imported so the queue knows nothing of what an effect is.

import { WATCHING, type ReactiveNode } from './system.ts'

const queued: (ReactiveNode | undefined)[] = []
let notifyIndex = 0
let queuedLength = 0
let scheduled = false
let draining = false

/** system.ts's `notify`: queue an effect and the watching effects it is owned by, parents first. */
export function enqueue(node: ReactiveNode): void {
  let insertIndex = queuedLength
  let firstInsertedIndex = insertIndex
  let e: ReactiveNode | undefined = node
  do {
    queued[insertIndex++] = e
    e.flags &= ~WATCHING
    e = e.subs?.sub
  } while (e !== undefined && e.flags & WATCHING)
  queuedLength = insertIndex
  // reverse the inserted run so parent effects run before their children
  while (firstInsertedIndex < --insertIndex) {
    const left = queued[firstInsertedIndex]
    queued[firstInsertedIndex++] = queued[insertIndex]
    queued[insertIndex] = left
  }
}

/** Ask for a drain on the next microtask; one per burst. */
export function schedule<N extends ReactiveNode>(run: (node: N) => void): void {
  // wakes raised mid-drain are run by the running loop — no microtask needed
  if (scheduled || draining) return
  scheduled = true
  // Promise, not queueMicrotask: pure ES, keeps core free of host-specific APIs
  Promise.resolve().then(() => {
    scheduled = false
    drain(run)
  })
}

/** Run everything queued now, including what the runs themselves queue; rethrows the first error once all have run. */
export function drain<N extends ReactiveNode>(run: (node: N) => void): void {
  const prevDraining = draining
  draining = true
  let firstError: unknown
  let errored = false
  try {
    while (notifyIndex < queuedLength) {
      const e = queued[notifyIndex] as N
      queued[notifyIndex++] = undefined
      try {
        run(e)
      } catch (error) {
        // one effect throwing must not strand the ones queued behind it
        if (!errored) {
          errored = true
          firstError = error
        }
      }
    }
  } finally {
    draining = prevDraining
    notifyIndex = 0
    queuedLength = 0
  }
  if (errored) throw firstError
}
