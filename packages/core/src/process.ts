// The process runtime: spawn drives an async generator, publishing every
// yield through a graph `source` — so process reads inside derives/effects get
// path-precise wakes for free, and the local update path is literally the wire
// codec.
//
// Lifecycle:
//   - Self: FIFO sequential mailbox; `latest()` drops the queue and skips to
//     the newest message; `signal` aborts per instance; `cast` is the self-cast.
//   - Ownership: spawns during the synchronous window of a process resumption
//     attach to that process and die with it. Dispose order: mailbox closes,
//     `finally` blocks run, owned children die — in that order.
//   - Crash: readers keep the last value with `stale: true`; pending calls
//     REJECT; queued casts survive into the restarted instance and replay.
//     `restart: 'on-crash'` re-runs the generator from its init args (the
//     recovery state, Erlang position) up to `maxRestarts` times.
//   - Bounded mailbox (`mailbox: n`): overflow drops the oldest message
//     (a dropped call rejects), with a one-shot dev warning.

import { source, effect, untracked } from './graph.ts'
import type { Json } from './reconcile.ts'
import type { Proc, Process, Self } from './types.ts'

export interface SpawnOpts<T> {
  /** First readable value; decides `Process<T>` vs `Process<T | undefined>`. */
  initial?: T
  /** 'on-crash' re-runs the generator from its args after a throw. Default 'never'. */
  restart?: 'never' | 'on-crash'
  /** Restart budget for 'on-crash' (default 3); exceeded → terminal crash. */
  maxRestarts?: number
  /** Mailbox bound; overflow drops the oldest message (drop-oldest, dev warning). */
  mailbox?: number
}

// ---------- mailbox ----------

interface MailboxHooks<In> {
  bound?: number
  onDrop?: (msg: In) => void
  onDeliver?: () => void
  onIdle?: () => void
}

interface Taker<In> {
  resolve: (r: IteratorResult<In>) => void
  latest: boolean
}

class Mailbox<In> {
  private queue: In[] = []
  private takers: Taker<In>[] = []
  private warned = false
  private drainScheduled = false
  private hooks: MailboxHooks<In>
  closed = false

  // no parameter property: the package ships erasable-syntax-only TS
  constructor(hooks: MailboxHooks<In>) {
    this.hooks = hooks
  }

  push(msg: In): void {
    if (this.closed) {
      this.hooks.onDrop?.(msg)
      return
    }
    const head = this.takers[0]
    if (head !== undefined && !head.latest) {
      this.takers.shift()
      this.hooks.onDeliver?.()
      head.resolve({ value: msg, done: false })
      return
    }
    this.queue.push(msg)
    // a waiting latest() taker gets the newest of the burst, not the first:
    // defer delivery one microtask so same-tick casts can supersede
    if (head !== undefined) this.scheduleDrain()
    const bound = this.hooks.bound
    if (bound !== undefined && this.queue.length > bound) {
      const dropped = this.queue.shift() as In
      if (!this.warned) {
        this.warned = true
        console.warn(`nonchalant: mailbox overflow (bound ${bound}) — dropping oldest message`)
      }
      this.hooks.onDrop?.(dropped)
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return
    this.drainScheduled = true
    Promise.resolve().then(() => {
      this.drainScheduled = false
      const head = this.takers[0]
      if (this.closed || this.queue.length === 0 || head === undefined || !head.latest) return
      this.takers.shift()
      this.hooks.onDeliver?.()
      head.resolve({ value: this.drainToNewest(), done: false })
    })
  }

  private drainToNewest(): In {
    const msg = this.queue[this.queue.length - 1] as In
    for (let i = 0; i < this.queue.length - 1; i++) this.hooks.onDrop?.(this.queue[i] as In)
    this.queue.length = 0
    return msg
  }

  take(latest: boolean): Promise<IteratorResult<In>> {
    if (this.queue.length > 0) {
      const msg = latest ? this.drainToNewest() : (this.queue.shift() as In)
      this.hooks.onDeliver?.()
      return Promise.resolve({ value: msg, done: false })
    }
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
    this.hooks.onIdle?.()
    return new Promise((resolve) => this.takers.push({ resolve, latest }))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const taker of this.takers) taker.resolve({ value: undefined as never, done: true })
    this.takers = []
    for (const msg of this.queue) this.hooks.onDrop?.(msg)
    this.queue = []
  }
}

const selfFor = <In>(mailbox: Mailbox<In>, signal: AbortSignal, cast: (msg: In) => void): Self<In> => ({
  signal,
  cast,
  [Symbol.asyncIterator]: (): AsyncIterator<In> => ({ next: () => mailbox.take(false) }),
  latest: (): AsyncIterable<In> => ({
    [Symbol.asyncIterator]: (): AsyncIterator<In> => ({ next: () => mailbox.take(true) }),
  }),
})

/**
 * A standalone Self — a private mailbox for wrapping or testing processes
 * (middleware hands one to an inner proc). Iteration ends when `signal` aborts
 * or the channel is disposed.
 */
export function channel<In>(signal?: AbortSignal): Self<In> & Disposable {
  const mailbox = new Mailbox<In>({})
  const controller = signal === undefined ? new AbortController() : undefined
  const sig = signal ?? controller!.signal
  if (signal !== undefined) {
    if (signal.aborted) mailbox.close()
    else signal.addEventListener('abort', () => mailbox.close(), { once: true })
  }
  return Object.assign(selfFor(mailbox, sig, (msg) => mailbox.push(msg)), {
    [Symbol.dispose]: (): void => {
      controller?.abort()
      mailbox.close()
    },
  })
}

// ---------- ownership scope ----------

interface ProcessCore {
  children: Set<ProcessCore>
  dispose(): void
  settled(): Promise<void>
}

// Ambient scope, valid during the synchronous window of a process resumption
// (body code between a resume and its next await/yield). Spawns after an
// intervening await inside one step run unowned — spawn before awaiting.
let currentScope: ProcessCore | null = null

/** Internal (registry): run fn with ambient ownership suspended — shared
 * processes must not be owned by whichever process happened to look them up. */
export function unscoped<T>(fn: () => T): T {
  const prev = currentScope
  currentScope = null
  try {
    return fn()
  } finally {
    currentScope = prev
  }
}

// ---------- spawn ----------

type Meta = { pending: boolean; stale: boolean; errored: boolean }

export function spawnProcess<T, In, A>(
  proc: Proc<T, In, A>,
  args: A,
  opts?: SpawnOpts<T>,
  internal?: { onWatchers?: (count: number) => void; onSettled?: () => void },
): Process<T | undefined, In> {
  const mailboxBound = opts?.mailbox
  if (mailboxBound !== undefined && (!Number.isInteger(mailboxBound) || mailboxBound < 0))
    throw new Error('nonchalant: mailbox must be a non-negative integer')
  const maxRestarts = opts?.maxRestarts
  if (
    maxRestarts !== undefined &&
    maxRestarts !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(maxRestarts) || maxRestarts < 0)
  ) throw new Error('nonchalant: maxRestarts must be a non-negative integer or Infinity')

  const hasInitial = opts !== undefined && 'initial' in opts
  let valueWatchers = 0
  let metaWatchers = 0
  const reportWatchers = (): void => internal?.onWatchers?.(valueWatchers + metaWatchers)
  const src = source<Json>(
    (hasInitial ? opts.initial : undefined) as unknown as Json,
    internal?.onWatchers !== undefined
      ? { onWatchers: (count) => { valueWatchers = count; reportWatchers() } }
      : undefined,
  )
  const meta = source<Meta>(
    { pending: true, stale: false, errored: false },
    internal?.onWatchers !== undefined
      ? { onWatchers: (count) => { metaWatchers = count; reportWatchers() } }
      : undefined,
  )
  let m: Meta = { pending: true, stale: false, errored: false }
  const setMeta = (patch: Partial<Meta>): void => {
    const next = { ...m, ...patch }
    if (next.pending === m.pending && next.stale === m.stale && next.errored === m.errored) return
    m = next
    meta.publish(next)
  }

  let phase: 'running' | 'done' | 'crashed' | 'disposed' = 'running'
  let errorValue: unknown
  let hasValue = hasInitial
  let gen: AsyncGenerator<T> | null = null
  let controller = new AbortController()
  let restarts = 0

  const pendingCalls = new Map<object, (err: unknown) => void>()
  const rejectAsks = (err: unknown): void => {
    for (const reject of pendingCalls.values()) reject(err)
    pendingCalls.clear()
  }

  const mailbox = new Mailbox<In>({
    ...(opts?.mailbox !== undefined ? { bound: opts.mailbox } : {}),
    onDrop: (msg) => {
      const reject = pendingCalls.get(msg as object)
      if (reject !== undefined) {
        pendingCalls.delete(msg as object)
        reject(new Error('nonchalant: call dropped — mailbox overflow or process ended'))
      }
    },
    onDeliver: () => setMeta({ pending: true }),
    onIdle: () => setMeta({ pending: false }),
  })

  let completion: Promise<void> = Promise.resolve()
  const core: ProcessCore = {
    children: new Set(),
    dispose: () => disposeProcess(),
    settled: () => completion,
  }
  const parent = currentScope
  if (parent !== null) parent.children.add(core)

  const childSettlements = new Set<Promise<void>>()
  const disposeChildren = (): void => {
    for (const child of [...core.children]) {
      child.dispose()
      const settled = child.settled()
      childSettlements.add(settled)
      void settled.finally(() => childSettlements.delete(settled))
    }
    core.children.clear()
  }

  // scope window: body code runs synchronously inside this call until its
  // first await/yield — spawns in that window attach to this process
  const step = <R>(fn: () => Promise<R>): Promise<R> => {
    const prev = currentScope
    currentScope = core
    try {
      return fn()
    } finally {
      currentScope = prev
    }
  }

  const drive = async (): Promise<void> => {
    while (true) {
      controller = new AbortController()
      const g = proc(selfFor(mailbox, controller.signal, (msg) => mailbox.push(msg)), args)
      gen = g
      try {
        while (true) {
          const r = await step(() => g.next())
          if (r.done) {
            if (phase === 'running') {
              phase = 'done'
              setMeta({ pending: false })
            }
            break
          }
          src.publish(r.value as unknown as Json)
          hasValue = true
          errorValue = undefined
          setMeta({ pending: false, stale: false, errored: false })
        }
      } catch (err) {
        if (phase !== 'disposed') {
          errorValue = err
          controller.abort()
          rejectAsks(err)
          disposeChildren() // the crashed instance's spawns die with it
          if (opts?.restart === 'on-crash' && restarts < (opts.maxRestarts ?? 3)) {
            restarts++
            setMeta({ pending: true, stale: true, errored: true })
            continue // same mailbox: queued casts replay into the fresh instance
          }
          phase = 'crashed'
          setMeta({ pending: false, stale: true, errored: true })
        }
      }
      break
    }
    // end of life, any path: generator settled (finally blocks have run)
    gen = null
    mailbox.close()
    rejectAsks(
      errorValue !== undefined && phase === 'crashed'
        ? errorValue
        : new Error(`nonchalant: process ${phase === 'disposed' ? 'disposed' : 'ended'}`),
    )
    disposeChildren() // owned children die last: mailbox, then finally blocks, then children
    await Promise.all([...childSettlements])
    if (parent !== null) parent.children.delete(core)
    internal?.onSettled?.()
  }

  const disposeProcess = (): void => {
    if (phase === 'disposed' || phase === 'done' || phase === 'crashed') {
      if (phase !== 'disposed') {
        phase = 'disposed'
        setMeta({ stale: true })
      }
      disposeChildren()
      for (const finish of [...closers]) finish()
      return
    }
    phase = 'disposed'
    if (parent !== null) parent.children.delete(core)
    mailbox.close() // 1. mailbox closes: body's `for await` ends, queued calls reject
    controller.abort()
    const g = gen
    if (g !== null) void step(() => g.return(undefined as never)).catch(() => {}) // 2. finally blocks run; 3. drive() then disposes children
    setMeta({ pending: false, stale: true })
    for (const finish of [...closers]) finish()
  }

  // ---------- outside face ----------

  const read = (): T | undefined => src() as unknown as T | undefined

  const closers = new Set<() => void>()

  completion = drive()

  const asyncIterator = (): AsyncIterator<T> => {
    let buffered = false
    let latest: T | undefined
    let emitted = false
    let ended = false
    let wake: (() => void) | undefined
    const signalWake = (): void => {
      const w = wake
      wake = undefined
      if (w) w()
    }
    const stop = effect(() => {
      void meta() // subtree dep: wakes on lifecycle transitions
      void src() // subtree dep: wakes on every yield
      if (hasValue) {
        const v = untracked(() => src()) as unknown as T
        if (!emitted || !Object.is(v, latest)) {
          latest = v
          emitted = true
          buffered = true
        }
      }
      if (phase !== 'running') ended = true
      signalWake()
    })
    const finish = (): void => {
      if (!ended) ended = true
      stop()
      closers.delete(finish)
      signalWake()
    }
    closers.add(finish)
    return {
      async next(): Promise<IteratorResult<T>> {
        while (!buffered && !ended) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
        if (buffered) {
          buffered = false
          return { value: latest as T, done: false }
        }
        finish()
        return { value: undefined as never, done: true }
      },
      async return(): Promise<IteratorResult<T>> {
        finish()
        return { value: undefined as never, done: true }
      },
    }
  }

  const call = (msg: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (phase !== 'running') {
        reject(new Error(`nonchalant: call on ${phase} process`))
        return
      }
      const full = {
        ...msg,
        reply: (res: unknown): void => {
          pendingCalls.delete(full)
          resolve(res)
        },
      }
      pendingCalls.set(full, reject)
      mailbox.push(full as In)
    })

  Object.defineProperties(read, {
    pending: { get: () => meta().pending },
    stale: { get: () => meta().stale },
    error: {
      get: () => {
        void meta().errored // tracked contexts wake when the error state flips
        return errorValue
      },
    },
  })
  const p = read as unknown as Record<PropertyKey, unknown>
  p['cast'] = (msg: In): void => mailbox.push(msg)
  p['call'] = call
  p[Symbol.asyncIterator] = asyncIterator
  p[Symbol.dispose] = disposeProcess
  p[Symbol.asyncDispose] = async (): Promise<void> => {
    disposeProcess()
    await completion
  }
  return read as unknown as Process<T | undefined, In>
}
