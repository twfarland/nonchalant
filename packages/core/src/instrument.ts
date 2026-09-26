// The runtime's two global observation slots: the crash handler and the
// instrument sink. Each holds one function at a time; the runtime reads the
// live bindings at every report site.

import type { Patch } from './reconcile.ts'

// ---------- crash observer ----------

export let crashHandler: ((error: unknown, name: string) => void) | undefined

/**
 * Observe every process crash, including ones a restart recovers from: the
 * thrown value and the proc's function name. One handler at a time; returns
 * its remover. Without one, a crash shows only on the handle (`error`,
 * `stale`) and in rejected calls.
 */
export function onProcessError(handler: (error: unknown, name: string) => void): () => void {
  crashHandler = handler
  return () => {
    if (crashHandler === handler) crashHandler = undefined
  }
}

// ---------- instrumentation ----------

/**
 * What the runtime reports to an `instrument` sink. Payloads are the live
 * values (messages, replies, errors), not copies; `yield` carries the patch
 * the yield produced rather than the whole state. `state` on `spawn` is the
 * initial value, so spawn state + every yield's ops = the current state.
 */
export type ProcessEvent =
  | { type: 'spawn'; id: number; parent: number | null; name: string; key: string | undefined; args: unknown; state: unknown }
  | { type: 'cast'; id: number; msg: unknown }
  | { type: 'call'; id: number; msg: unknown; call: number }
  | { type: 'reply'; id: number; call: number; value: unknown }
  | { type: 'yield'; id: number; ops: Patch }
  | { type: 'status'; id: number; pending: boolean; stale: boolean; errored: boolean }
  | { type: 'crash'; id: number; error: unknown }
  | { type: 'restart'; id: number; attempt: number }
  | { type: 'exit'; id: number; reason: 'done' | 'crashed' | 'disposed' }

// every emit site is `sink?.(...)`: with no sink the argument is never built
export let sink: ((event: ProcessEvent) => void) | undefined

/**
 * Report every process event to `fn`, synchronously, as it happens. One sink
 * at a time; returns its remover. Events a sink causes (a cast from inside
 * it) are reported to it re-entrantly.
 */
export function instrument(fn: (event: ProcessEvent) => void): () => void {
  sink = fn
  return () => {
    if (sink === fn) sink = undefined
  }
}
