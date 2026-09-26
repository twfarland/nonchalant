// Durability as a wrapper, not a runtime. `durable(proc, opts)` returns an
// ordinary Proc, so it goes in a registry, over the wire, and under a view like
// any other — the process inside it is written the way every other process in
// this repo is written.
//
// The transaction boundary is one message. A message is journaled before it is
// handled; the effects inside it are journaled as they complete; and when the
// process requests its *next* message, the state it produced, the cursor past
// that message, and the answers it gave to calls are committed together. Crash
// anywhere in between and the message is redelivered with its completed effects
// already answered — so the generator re-runs, and the effects do not.
//
// Calls are durable too, which is what makes a durable process worth calling: a
// call carries an idempotency key, its answer is committed under that key, and a
// retry with the same key is answered from the record instead of running again.
// An answer is released to the caller only once it is committed, so nobody is
// ever told something a crash could take back.
//
// `Self` being an interface is what makes all of this possible: the process
// iterates a mailbox that acknowledges, and cannot tell.

import type { Json, Proc, Self } from '@nonchalant/core'
import { Fenced } from './store.ts'
import type { DeadLetter, Logged, Store, StepRecord } from './store.ts'
import { nextAttempt, plainly, recall, restore } from './replay.ts'

export interface Durable<T> {
  /** The last committed state (migrated to the current version), or undefined on a first activation. Start from it. */
  readonly restored: T | undefined
  /**
   * Run an effect and record its result. Execution is at-least-once — an
   * effect in flight when the process dies runs again — and recording is
   * exactly-once: once the result is written, a replay returns it and `fn` is
   * not called. So anything non-deterministic (a clock, an id, a charge)
   * belongs inside one of these. `fn` receives an idempotency key, stable
   * across replays of this step, to hand to the outside world.
   */
  step<R extends Json>(name: string, fn: (idempotencyKey: string) => R | Promise<R>): Promise<R>
  /**
   * A call to another process, journaled on both sides: a step whose
   * idempotency key is the callId, so a replay calls with the same id — and a
   * durable callee answers it from its record rather than doing the work twice.
   */
  call<R extends Json>(name: string, invoke: (callId: string) => Promise<R>): Promise<R>
  /** A sleep whose deadline is journaled: after a restart it waits out the remainder, not the whole duration. */
  sleep(name: string, ms: number): Promise<void>
}

export type DurableProc<T, In, Args> = (self: Self<In>, args: Args, durable: Durable<T>) => AsyncGenerator<T>

export interface DurableOpts<T, Args> {
  store: Store
  /** The storage identity of this instance — usually the registry lookup args. */
  key: (args: Args) => string
  /** Wall clock, for `sleep`. Injected so tests do not wait. Default `Date.now`. */
  now?: () => number
  /** The snapshot schema version this code writes. Default 0. */
  version?: number
  /** Bring a snapshot committed under an older version up to date. Required once `version` moves. */
  migrate?: (old: Json, from: number) => NoInfer<T>
  /**
   * How many times one message may crash the process before it is moved to the
   * dead letters and the cursor steps past it. Default: no limit.
   */
  maxAttempts?: number
  /** Told after a message is dead-lettered. */
  onPoison?: (key: string, dead: DeadLetter) => void
}

/**
 * What a durable process may be sent: plain data, or a call that carries its own
 * idempotency key. A call without one could not be answered twice safely, and a
 * message that is not plain data could not be written down.
 */
export type DurableCall = { readonly callId: string; readonly reply: (res: never) => void }

type Reply = (res: Json | Promise<never>) => void

// rejects on abort: a disposed process must not wake up and run the effects after its sleep
export const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted()
    // drop the listener when the timer wins: one sleep per message would
    // otherwise leave one listener per message on a long-lived signal
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

export function durable<T extends Json, In extends Json | DurableCall, Args>(
  proc: DurableProc<T, In, Args>,
  opts: DurableOpts<T, Args>,
): Proc<T, In, Args> {
  const { store, now = Date.now, version = 0, migrate, maxAttempts = Infinity } = opts

  return async function* (self: Self<In>, args: Args): AsyncGenerator<T> {
    const key = opts.key(args)
    const loaded = await store.load(key)
    const { epoch } = loaded

    let cursor = loaded.cursor
    let latest = restore(loaded, version, migrate, key)

    let current: Logged | undefined // the message in flight
    let handling = 0 // its seq; 0 before the first one
    let before: T | undefined // the state it was handed out against
    let inside = false // true while user code handles it: a throw now is the message's fault
    let stepIndex = 0
    let recorded: StepRecord[] = []
    let answers: [string, Json][] = []

    // journaled messages waiting for the process; one reader, ended by the signal
    const inbox: Logged[] = []
    let wake = (): void => {}
    const push = (logged: Logged): void => {
      inbox.push(logged)
      wake()
    }
    self.signal.addEventListener('abort', () => wake(), { once: true })

    // callers waiting on an answer; a replayed call starts with none, so a
    // retry under its id attaches instead of being journaled twice
    const waiting = new Map<string, Reply[]>()
    const settle = (callId: string, answer: Json): void => {
      for (const reply of waiting.get(callId) ?? []) reply(answer)
      waiting.delete(callId)
    }

    // a store failure is never the message's fault, so it must not count as an attempt
    const write = <R>(p: Promise<R>): Promise<R> =>
      p.catch((e: unknown) => {
        inside = false
        throw e
      })

    // everything the log holds past the cursor goes in first, in order: a
    // restart is a redelivery, not a special mode
    for (const logged of await store.pending(key, cursor)) {
      if (logged.callId !== undefined) waiting.set(logged.callId, [])
      push(logged)
    }

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
      appending = appending.then(async () => {
        if (broken) return
        try {
          const { reply, callId } = msg as { reply?: Reply; callId?: unknown }
          if (typeof reply !== 'function') {
            push({ seq: await write(store.append(key, epoch, msg as Json)), msg: msg as Json })
            return
          }
          // enforced here as well as in the types: a call journaled without an
          // id could never be answered from the record, and its reply would be
          // replayed as data
          if (typeof callId !== 'string') return reply(Promise.reject(new Error('nonchalant/durable: a call needs a callId')))
          const attached = waiting.get(callId)
          if (attached !== undefined) return void attached.push(reply) // already in flight under this id
          waiting.set(callId, [reply])
          const answered = await store.result(key, callId)
          if (answered !== undefined) return settle(callId, answered) // asked and answered before: no work, no log entry
          const plain = plainly(msg as object)
          push({ seq: await write(store.append(key, epoch, plain, callId)), msg: plain, callId })
        } catch (e) {
          broken = true
          fail(e)
        }
      })
    }

    void (async () => {
      for await (const msg of self) {
        // a crashed instance's reader may still be waiting on a restarted
        // process's mailbox: hand what it takes to the new instance
        if (self.signal.aborted) return self.cast(msg)
        journal(msg)
      }
    })()

    const commit = async (dead?: DeadLetter): Promise<void> => {
      if (handling <= cursor) return
      const results = answers
      answers = []
      await write(store.commit(key, epoch, dead === undefined
        ? { snapshot: latest, version, cursor: handling, results }
        : { snapshot: before, version, cursor: handling, results: [], dead }))
      cursor = handling
      for (const [callId, answer] of results) settle(callId, answer)
    }

    // `newest` skips to the last message queued; the ones it passes over are acknowledged with it
    const deliver = (newest: boolean): AsyncIterator<In> => ({
      async next(): Promise<IteratorResult<In>> {
        inside = false
        await commit() // asking for the next message is what finishes the last one
        while (inbox.length === 0 && !self.signal.aborted)
          await Promise.race([new Promise<void>((resolve) => (wake = resolve)), failed])
        if (self.signal.aborted) return { value: undefined as never, done: true }
        current = (newest ? inbox.splice(0).pop() : inbox.shift()) as Logged
        const { seq, msg, callId } = current
        handling = seq
        before = latest
        stepIndex = 0
        recorded = await store.steps(key, seq)
        inside = true
        // a call's reply is recorded with the commit, and released once it lands
        return {
          value: (callId === undefined ? msg : { ...(msg as object), reply: (res: Json) => answers.push([callId, res]) }) as In,
          done: false,
        }
      },
    })

    const inner: Self<In> = {
      signal: self.signal,
      cast: journal,
      latest: () => ({ [Symbol.asyncIterator]: () => deliver(true) }),
      [Symbol.asyncIterator]: () => deliver(false),
    }

    // `wakes`: the result is a deadline, and the key is due at it — so a
    // scheduler activates it even if nothing looks it up
    const step = async <R extends Json>(name: string, fn: (idempotencyKey: string) => R | Promise<R>, wakes?: true): Promise<R> => {
      const seq = handling
      const index = stepIndex++
      const done = recall(recorded, index, name, key, seq)
      if (done !== undefined) return done.result as R
      self.signal.throwIfAborted() // disposed: the next activation runs it, not this one
      const result = await fn(`${key}#${seq}#${index}`)
      await write(store.putStep(key, epoch, seq, index, name, result, wakes && (result as number)))
      return result
    }

    const ctx: Durable<T> = {
      restored: latest,
      step: (name, fn) => step(name, fn),
      call: (name, fn) => step(name, fn),
      sleep: async (name, ms) => {
        const left = (await step(`${name}:deadline`, () => now() + ms, true)) - now()
        if (left > 0) await delay(left, self.signal)
      },
    }

    try {
      for await (const value of proc(inner, args, ctx)) {
        latest = value
        yield value
      }
      await commit() // a process that returns acknowledges its last message
    } catch (e) {
      // superseded by a later activation: stop, and leave the key to it
      if (e instanceof Fenced) return
      // a host dying outright, or disposal, is not counted as an attempt
      if (inside && maxAttempts !== Infinity && !self.signal.aborted) {
        const attempt = nextAttempt(recorded, maxAttempts)
        const error = String(e)
        // due at once: a scheduler redelivers it where no supervisor restarts it
        if (attempt !== undefined) await write(store.putStep(key, epoch, handling, -attempt, 'attempt', error, now()))
        else {
          const dead = { ...(current as Logged), error }
          await commit(dead)
          opts.onPoison?.(key, dead)
        }
      }
      throw e
    }
  }
}
