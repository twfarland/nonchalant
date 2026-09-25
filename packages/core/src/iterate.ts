// The async-iterator face shared by processes and derives: an effect re-runs
// `pull` on every wake and keeps ONE buffered slot, overwritten by newer
// values and deduplicated with Object.is — lossy latest-value delivery.
//
// `pull` returns NONE for "no value yet"; a throw ends iteration with that
// error. The owner ends every open iterator by calling the closers it passed
// in; each closer pulls once more (untracked) first, so a value published in
// the same tick as the end is still delivered before `done`. Concurrent
// next() calls queue and settle in call order.

import { effect, untracked } from './graph.ts'

export const NONE: unique symbol = Symbol()

export function iterate<T>(
  pull: () => T | typeof NONE,
  closers: Set<() => void>,
  live: boolean,
): AsyncIterator<T> {
  let latest: T | typeof NONE = NONE
  let buffered = false
  let failed = false
  let failure: unknown
  let ended = false
  let waiters: (() => void)[] = []
  let stop = (): void => {}

  const wake = (): void => {
    const parked = waiters
    waiters = []
    for (const resolve of parked) resolve()
  }
  const take = (): void => {
    try {
      const v = pull()
      if (v !== NONE && !Object.is(v, latest)) {
        latest = v
        buffered = true
      }
    } catch (e) {
      failure = e
      failed = true
      buffered = false
    }
    wake()
  }
  const finish = (): void => {
    if (ended) return
    ended = true
    stop()
    closers.delete(end)
    wake()
  }
  const end = (): void => {
    untracked(take)
    finish()
  }

  if (live) {
    stop = effect(take)
    closers.add(end)
  } else end()

  return {
    async next(): Promise<IteratorResult<T>> {
      while (!buffered && !failed && !ended) await new Promise<void>((resolve) => waiters.push(resolve))
      if (buffered) {
        buffered = false
        return { value: latest as T, done: false }
      }
      if (failed) {
        const e = failure
        finish()
        failed = false
        throw e
      }
      return { value: undefined as never, done: true }
    },
    async return(): Promise<IteratorResult<T>> {
      finish()
      buffered = false
      return { value: undefined as never, done: true }
    },
  }
}
