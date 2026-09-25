// What makes a journaled deadline fire when nobody is looking. The store keeps
// each key's wake time; the scheduler asks it for the keys that are due and
// activates them, usually with a registry lookup — get-or-spawn, so a key
// already live here is left alone and one that is not starts and replays its
// log. It holds nothing: every scheduler on a store is interchangeable, and
// one that restarts catches up on whatever came due while it was gone.
//
// A wake is at-least-once. `due` leases each key it hands out, so schedulers
// sharing a store do not both wake a key on one pass; a wake that does not
// lead to a commit before the lease runs out comes due again. When two
// activations do meet, the store's epoch fencing decides: the later one owns
// the log and the earlier stops at its next write.

import type { Store } from './store.ts'

export interface SchedulerOpts {
  store: Store
  /** Activate one due key — usually `registry.lookup(name, argsOf(key))`. */
  wake: (key: string) => unknown
  /** Milliseconds between passes. Default 1000. */
  interval?: number
  /** How long a woken key stays hidden from other passes before it may be woken again. Default 30 000. */
  lease?: number
  /** Most keys fetched per store round trip; a pass keeps fetching until it gets fewer. Default 100. */
  limit?: number
  /** The clock wake times are compared against: the same one the durable processes use. Default `Date.now`. */
  now?: () => number
  /** Told when a pass or a wake throws; the pass goes on, and the key comes due again after its lease. Default `console.error`. */
  onError?: (error: unknown) => void
}

export interface Scheduler extends Disposable {
  /** Run one pass now: wake every key that is due. Resolves with the keys it woke. */
  tick(): Promise<string[]>
}

/** Wake durable keys whose journaled deadlines have passed. Runs a pass at once, then every `interval`, until disposed. */
export function scheduler(opts: SchedulerOpts): Scheduler {
  const { store, wake, interval = 1000, lease = 30_000, limit = 100, now = Date.now, onError = console.error } = opts
  // a pass drains until a fetch comes back short, which a limit below 1 never does
  if (!(limit >= 1)) throw new Error('nonchalant/durable: scheduler limit must be at least 1')
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async (): Promise<string[]> => {
    const woken: string[] = []
    for (;;) {
      const at = now()
      const keys = await store.due(at, at + lease, limit)
      for (const key of keys) {
        try {
          wake(key)
          woken.push(key)
        } catch (e) {
          onError(e)
        }
      }
      if (keys.length < limit || stopped) return woken
    }
  }

  // the next pass is scheduled after this one ends, so a slow store never overlaps passes
  const loop = async (): Promise<void> => {
    try {
      await tick()
    } catch (e) {
      onError(e)
    }
    if (!stopped) timer = setTimeout(loop, interval)
  }
  void loop()

  return {
    tick,
    [Symbol.dispose]: () => {
      stopped = true
      clearTimeout(timer)
    },
  }
}
