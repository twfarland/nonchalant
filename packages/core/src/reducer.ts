// Optional sugar, like `cell`. A reducer is the common process shape (one
// message in, at most one state out, nothing awaited) written as a function
// instead of a loop. It compiles to an ordinary Proc, so spawn, define,
// durable, restart, and the wire treat it exactly like a hand-written
// generator.

import type { Proc, Self } from './types.ts'

/**
 * The next state for one message. Return `state` itself for "no change": the
 * process then yields nothing. A `Call` member answers through `msg.reply`
 * before returning: state is also what readers see, so there is nowhere
 * private to park a reply for later. That is a generator's job.
 */
export type Reducer<T, In> = (state: T, msg: In) => T

/**
 * A process from an initial state and a reducer. `init` runs once per start
 * (again on an `on-crash` restart) with the spawn args; under `durable` the
 * restored snapshot replaces it. The process is named after `reduce`, which is
 * what the inspector and `onProcessError` show, so give it a name.
 */
export function reducer<T, In, A = void>(init: (args: A) => T, reduce: Reducer<T, In>): Proc<T, In, A> {
  // the third parameter is durable's handle, typed structurally so core never imports durable
  const proc = async function* (self: Self<In>, args: A, d?: { readonly restored: T | undefined }) {
    let state = d?.restored ?? init(args)
    yield state
    for await (const msg of self) {
      const next = reduce(state, msg)
      if (next === state) continue
      state = next
      yield state
    }
  }
  return Object.defineProperty(proc, 'name', { value: reduce.name })
}
