// The state module: one process, one schema, no idea which thread it is on.
// The worker imports it to run it; the tab imports it for its types — and to
// run the very same definition when the demo is switched to this thread.

import type { Call, Definition, Proc } from '@nonchalant/core'

export type PrimesState = {
  tested: number
  count: number
  /** The last few found. The full list stays in the process; only this crosses. */
  recent: number[]
  running: boolean
}

export type PrimesMsg =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'reset' }
  | { type: 'grind' } // self-send: one chunk per turn of the event loop
  | Call<{ type: 'export' }, number[]>

/** Trial division, deliberately dumb — this is the load the demo moves off the UI thread. Odd n only. */
export function isPrime(n: number): boolean {
  for (let d = 3; d * d <= n; d += 2) if (n % d === 0) return false
  return true
}

/** Big enough that a single test costs real work: the divisor loop runs to √n ≈ 10⁶. */
export const FROM = 1_000_000_000_001
/** ~30ms of grinding. One chunk per message, so stop and export are heard between chunks. */
export const CHUNK = 100
const RECENT = 6

// The self-send goes through a timer, not straight into the mailbox: a loop
// that re-sends synchronously resolves in microtasks and the event loop never
// turns again — no port message, no frame, no timer would ever be heard.
const soon = (fn: () => void): void => {
  setTimeout(fn, 0)
}

export const primes: Proc<PrimesState, PrimesMsg, void> = async function* (self) {
  // the working set, and the one mutable thing here: it is not state, so it
  // never crosses — each yield takes a fresh slice of its tail instead
  const found: number[] = []
  let cursor = FROM
  let tested = 0
  let running = false

  const state = (): PrimesState => ({
    tested,
    count: found.length,
    recent: found.slice(-RECENT),
    running,
  })

  yield state()
  for await (const msg of self) {
    if (msg.type === 'start') {
      if (running) continue // no state change, no yield
      running = true
      soon(() => self.send({ type: 'grind' }))
    } else if (msg.type === 'stop') {
      if (!running) continue
      running = false
    } else if (msg.type === 'reset') {
      running = false
      found.length = 0
      cursor = FROM
      tested = 0
    } else if (msg.type === 'export') {
      msg.reply([...found]) // an answer is not a state change
      continue
    } else {
      if (!running) continue // a chunk queued behind a stop
      for (let i = 0; i < CHUNK; i++, cursor += 2) if (isPrime(cursor)) found.push(cursor)
      tested += CHUNK
      soon(() => self.send({ type: 'grind' })) // the next chunk is just the next message
    }
    yield state()
  }
}

export type Lab = { primes: Definition<PrimesState, PrimesMsg, void> }
