// One watched ref: an async iteration over the process, each observed
// snapshot sent as a patch against the previous observed one (lossy latest
// is exactly right for state sync: patches between consecutively observed
// snapshots always compose).

import { reconcile } from '@nonchalant/core'
import type { Json, ProcessBase } from '@nonchalant/core'
import type { HostMsg } from './protocol.ts'
import { errorJson } from './screen.ts'

export interface HostProcess extends ProcessBase<unknown> {
  cast?(msg: unknown): void
  call?(msg: unknown): Promise<unknown>
}

export interface Watch {
  name: string
  proc: HostProcess
  stop(): void
}

/**
 * Stream `proc` to `ref` until stopped. When the process ends on its own, its
 * last word (done, or a raise) goes to `finish`, which decides whether this
 * watch is still the one to say it.
 */
export function openWatch(
  ref: string,
  name: string,
  proc: HostProcess,
  send: (msg: HostMsg) => void,
  finish: (watch: Watch, last: HostMsg) => void,
): Watch {
  const it = proc[Symbol.asyncIterator]()
  let active = true
  const watch: Watch = {
    name,
    proc,
    stop: () => {
      active = false
      void it.return?.()
    },
  }
  void (async () => {
    let prev: Json | undefined
    let last: HostMsg
    try {
      while (active) {
        const r = await it.next()
        if (r.done) break
        const cur = r.value as Json
        const patch = reconcile(prev as Json, cur) // prev undefined on the first pass → full snapshot
        prev = cur
        if (patch.length > 0) send({ op: 'yield', ref, patch })
      }
      last = proc.error !== undefined ? { op: 'raise', ref, error: errorJson(proc.error) } : { op: 'done', ref }
    } catch (e) {
      last = { op: 'raise', ref, error: errorJson(e) }
    }
    if (active) finish(watch, last)
  })()
  return watch
}
