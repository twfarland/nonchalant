// Durability as a wrapper, not a runtime. `durable(proc, opts)` returns an
// ordinary Proc, so it goes in a registry, over the wire, and under a view like
// any other — the process inside it is written the way every other process in
// this repo is written.
//
// The transaction boundary is one message. A message is journaled before it is
// handled; the effects inside it are journaled as they complete; and when the
// process requests its *next* message, the state it produced and the cursor
// past that message are committed together. Crash anywhere in between and the
// message is redelivered with its completed effects already answered — so the
// generator re-runs, and the effects do not.
//
// Calls are durable too, which is what makes a durable process worth calling: a
// call carries an idempotency key, its answer is recorded under that key, and a
// retry with the same key is answered from the record instead of running again.
// One process crashing therefore does not make another do its work twice.
//
// `Self` being an interface is what makes all of this possible: the process
// iterates a mailbox that acknowledges, and cannot tell.

import { channel } from '@nonchalant/core'
import type { Json, Proc, Self } from '@nonchalant/core'
import type { Store, StepRecord } from './store.ts'

export interface Durable<T> {
  /** The last committed state, or undefined on a first activation. Start from it. */
  readonly restored: T | undefined
  /**
   * Run an effect at most once. On a replay the recorded result is returned and
   * `fn` is not called — so anything non-deterministic (a clock, an id, a
   * charge) belongs inside one of these.
   */
  step<R extends Json>(name: string, fn: () => R | Promise<R>): Promise<R>
  /**
   * A call to another process, journaled on both sides. The id handed to `invoke`
   * is derived from this process, the message being handled, and `name`, so a
   * replay calls with the same id — and a durable callee answers it from its
   * record rather than doing the work twice.
   */
  call<R extends Json>(name: string, invoke: (callId: string) => Promise<R>): Promise<R>
  /** A sleep whose deadline is journaled: after a restart it waits out the remainder, not the whole duration. */
  sleep(name: string, ms: number): Promise<void>
}

export type DurableProc<T, In, Args> = (self: Self<In>, args: Args, durable: Durable<T>) => AsyncGenerator<T>

export interface DurableOpts<Args> {
  store: Store
  /** The storage identity of this instance — usually the registry lookup args. */
  key: (args: Args) => string
  /** Wall clock, for `sleep`. Injected so tests do not wait. Default `Date.now`. */
  now?: () => number
}

/**
 * What a durable process may be sent: plain data, or a call that carries its own
 * idempotency key. A call without one could not be answered twice safely, and a
 * message that is not plain data could not be written down.
 */
export type DurableCall = { readonly callId: string; readonly reply: (res: never) => void }

interface Envelope<In> {
  seq: number
  msg: In
  callId?: string
}

interface Incoming {
  reply?: (res: Json) => void
  callId?: string
}

const isCall = (msg: unknown): msg is Incoming & { reply: (res: Json) => void; callId: string } => {
  const m = msg as Incoming
  return typeof m?.reply === 'function' && typeof m.callId === 'string'
}

/** The request without its reply: what gets written down. */
const plainly = (msg: object): Json => {
  const copy: Record<string, unknown> = { ...(msg as Record<string, unknown>) }
  delete copy['reply']
  return copy as Json
}

const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    // drop the listener when the timer wins: one sleep per message would
    // otherwise leave one listener per message on a long-lived signal
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

export function durable<T extends Json, In extends Json | DurableCall, Args>(
  proc: DurableProc<T, In, Args>,
  opts: DurableOpts<Args>,
): Proc<T, In, Args> {
  const now = opts.now ?? Date.now

  return async function* (self: Self<In>, args: Args): AsyncGenerator<T> {
    const { store } = opts
    const key = opts.key(args)
    const loaded = (await store.load(key)) ?? { snapshot: undefined, cursor: 0 }

    let cursor = loaded.cursor
    let latest = loaded.snapshot as T | undefined
    let handling = 0 // the message in flight; 0 before the first one
    let stepIndex = 0
    let recorded: StepRecord[] = []

    const inbox = channel<Envelope<In>>(self.signal)
    // callers waiting on an answer right now; a replayed call has none, and its
    // answer is recorded for whoever asks again
    const waiting = new Map<string, ((value: Json) => void)[]>()

    /** The reply the inner process is handed: record first, then tell anyone listening. */
    const replyFor = (callId: string) => (value: Json) => {
      void (async () => {
        await store.putResult(key, callId, value)
        for (const waiter of waiting.get(callId) ?? []) waiter(value)
        waiting.delete(callId)
      })()
    }

    const restore = (msg: Json, callId: string | undefined): In =>
      callId === undefined ? (msg as In) : ({ ...(msg as object), reply: replyFor(callId) } as unknown as In)

    // everything the log holds past the cursor goes in first, in order: a
    // restart is a redelivery, not a special mode
    for (const logged of await store.pending(key, cursor))
      inbox.cast({ seq: logged.seq, msg: restore(logged.msg, logged.callId), ...(logged.callId === undefined ? {} : { callId: logged.callId }) })

    // A store that will not accept a message must crash the process rather than
    // drop it: handling a message that was never written down is the one thing
    // durability cannot survive. The rejection is raced against delivery below,
    // so it surfaces the next time the process asks for a message.
    let broken = false
    let fail: (e: unknown) => void = () => {}
    const failed = new Promise<never>((_, reject) => {
      fail = reject
    })
    void failed.catch(() => {}) // nobody may be racing it yet

    // one serialized appender, so the log order is the delivery order for both
    // outside messages and the process's own self-casts
    let appending: Promise<void> = Promise.resolve()
    const journal = (msg: In): void => {
      if (broken) return
      appending = appending.then(async () => {
        if (broken) return
        try {
          if (isCall(msg)) {
            const { callId, reply } = msg
            const answered = await store.result(key, callId)
            if (answered !== undefined) {
              reply(answered) // asked before and already answered: no work, no log entry
              return
            }
            waiting.set(callId, [...(waiting.get(callId) ?? []), reply])
            if (waiting.get(callId)!.length > 1) return // already in flight under this id
            const seq = await store.append(key, plainly(msg), callId)
            inbox.cast({ seq, msg: restore(plainly(msg), callId), callId })
            return
          }
          const seq = await store.append(key, msg as Json)
          inbox.cast({ seq, msg })
        } catch (e) {
          broken = true
          fail(e)
        }
      })
    }

    void (async () => {
      for await (const msg of self) journal(msg)
    })()

    const commit = async (): Promise<void> => {
      if (handling <= cursor || latest === undefined) return
      await store.commit(key, latest, handling)
      cursor = handling
    }

    const deliver = (source: AsyncIterator<Envelope<In>>): AsyncIterator<In> => ({
      async next(): Promise<IteratorResult<In>> {
        for (;;) {
          await commit() // asking for the next message is what finishes the last one
          const r = await Promise.race([source.next(), failed])
          if (r.done === true) return { value: undefined as never, done: true }
          const { seq, msg, callId } = r.value
          // a call answered before the crash is acknowledged, not handled again
          if (callId !== undefined && (await store.result(key, callId)) !== undefined) {
            handling = seq
            continue
          }
          handling = seq
          stepIndex = 0
          recorded = await store.steps(key, seq)
          return { value: msg, done: false }
        }
      },
      async return(): Promise<IteratorResult<In>> {
        await source.return?.()
        return { value: undefined as never, done: true }
      },
    })

    const inner: Self<In> = {
      signal: self.signal,
      cast: journal,
      latest: () => ({ [Symbol.asyncIterator]: () => deliver(inbox.latest()[Symbol.asyncIterator]()) }),
      [Symbol.asyncIterator]: () => deliver(inbox[Symbol.asyncIterator]()),
    }

    const step = async <R extends Json>(name: string, fn: () => R | Promise<R>): Promise<R> => {
      const index = stepIndex++
      const done = recorded.find((s) => s.index === index)
      if (done !== undefined) {
        if (done.name !== name)
          throw new Error(
            `nonchalant/durable: step ${index} of this message was '${done.name}' and is now '${name}' — ` +
              'the order of steps within one message must not depend on anything unrecorded',
          )
        return done.result as R
      }
      const result = await fn()
      await store.putStep(key, handling, index, name, result as Json)
      return result
    }

    const ctx: Durable<T> = {
      restored: latest,
      step,
      call: (name, invoke) => step(name, () => invoke(`${key}#${handling}#${name}`)),
      sleep: async (name, ms) => {
        const deadline = await step(`${name}:deadline`, () => now() + ms)
        const left = deadline - now()
        if (left > 0) await delay(left, self.signal)
      },
    }

    for await (const value of proc(inner, args, ctx)) {
      latest = value
      yield value
    }
  }
}
