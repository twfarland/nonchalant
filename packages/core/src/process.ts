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
//   - Crash: readers keep the last value with `stale: true`; pending calls,
//     queued ones included, REJECT and leave the mailbox; queued casts
//     survive into the restarted instance and replay.
//   - Every exit from 'running' goes through `transition`; after it, yields
//     are not published and open iterators have ended.
//     `restart: 'on-crash'` re-runs the generator from its init args (the
//     recovery state, Erlang position) up to `maxRestarts` times.
//   - Bounded mailbox (`mailbox: n`): overflow drops the oldest message
//     (a dropped call rejects), with a one-shot dev warning.

import { source, untracked } from './graph.ts'
import { iterate, NONE } from './iterate.ts'
import { reconcile, type Json, type Patch } from './reconcile.ts'
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
  /** Crashes are expected and surfaced elsewhere (as `stale` and rejected calls); `onProcessError` skips them. */
  quiet?: boolean
}

// ---------- mailbox ----------

// FIFO with a moving head: O(1) amortized shift where Array#shift is O(n) at
// depth. Compacts once the consumed prefix is at least half the array.
class Fifo<T> {
  private items: (T | undefined)[] = []
  private head = 0

  size(): number {
    return this.items.length - this.head
  }

  push(v: T): void {
    this.items.push(v)
  }

  peek(): T | undefined {
    return this.items[this.head]
  }

  shift(): T {
    const v = this.items[this.head] as T
    this.items[this.head++] = undefined // release for gc before compaction
    if (this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head)
      this.head = 0
    }
    return v
  }

  drain(): T[] {
    const rest = this.items.slice(this.head) as T[]
    this.items = []
    this.head = 0
    return rest
  }
}

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
  readonly queue = new Fifo<In>()
  private takers = new Fifo<Taker<In>>()
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
    const head = this.takers.peek()
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
    if (bound !== undefined && this.queue.size() > bound) {
      const dropped = this.queue.shift()
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
      const head = this.takers.peek()
      if (this.closed || this.queue.size() === 0 || head === undefined || !head.latest) return
      this.takers.shift()
      this.hooks.onDeliver?.()
      head.resolve({ value: this.drainToNewest(), done: false })
    })
  }

  private drainToNewest(): In {
    const all = this.queue.drain()
    const msg = all.pop() as In
    for (const dropped of all) this.hooks.onDrop?.(dropped)
    return msg
  }

  take(latest: boolean): Promise<IteratorResult<In>> {
    if (this.queue.size() > 0) {
      const msg = latest ? this.drainToNewest() : this.queue.shift()
      this.hooks.onDeliver?.()
      return Promise.resolve({ value: msg, done: false })
    }
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
    this.hooks.onIdle?.()
    return new Promise((resolve) => this.takers.push({ resolve, latest }))
  }

  /** `wrap` runs around the resolution of parked takers (process: resume in scope). */
  close(wrap = (resolveTakers: () => void): void => resolveTakers()): void {
    if (this.closed) return
    this.closed = true
    const takers = this.takers.drain()
    wrap(() => {
      for (const taker of takers) taker.resolve({ value: undefined as never, done: true })
    })
    for (const msg of this.queue.drain()) this.hooks.onDrop?.(msg)
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
  id: number
  children: Set<ProcessCore>
  dispose(): void
  settled(): Promise<void>
}

// Ambient scope, valid during the synchronous window of a process resumption
// (body code between a resume and its next await/yield). Spawns after an
// intervening await inside one step run unowned — spawn before awaiting. One
// extension: the resumption that disposal causes by closing the mailbox (see
// disposeProcess), so a `finally` it triggers owns what it spawns.
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

// ---------- crash observer ----------

let crashHandler: ((error: unknown, name: string) => void) | undefined

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
let sink: ((event: ProcessEvent) => void) | undefined
let lastId = 0
let lastCall = 0

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

// ---------- spawn ----------

type Meta = { pending: boolean; stale: boolean; errored: boolean }
type Phase = 'running' | 'done' | 'crashed' | 'disposed'

export function spawnProcess<T, In, A>(
  proc: Proc<T, In, A>,
  args: A,
  opts?: SpawnOpts<T>,
  internal?: { onWatchers?: (count: number) => void; onSettled?: () => void; busy?: () => boolean; key?: string },
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
  const id = ++lastId
  let m: Meta = { pending: true, stale: false, errored: false }
  const setMeta = (patch: Partial<Meta>): void => {
    const next = { ...m, ...patch }
    if (next.pending === m.pending && next.stale === m.stale && next.errored === m.errored) return
    m = next
    sink?.({ type: 'status', id, ...next })
    meta.publish(next)
  }

  let phase: Phase = 'running'
  let errorValue: unknown
  let hasValue = hasInitial
  let gen: AsyncGenerator<T> | null = null
  let controller = new AbortController()
  let restarts = 0
  const closers = new Set<() => void>()

  // Every exit from 'running' (and a finished process's move to 'disposed')
  // goes through here: final meta, then every open iterator ends. Values
  // publish only while 'running', so a body still unwinding after its end
  // cannot un-stale the handle.
  const transition = (to: Exclude<Phase, 'running'>, patch: Partial<Meta>): void => {
    phase = to
    sink?.({ type: 'exit', id, reason: to })
    setMeta(patch)
    for (const end of [...closers]) end()
  }

  const pendingCalls = new Map<object, (err: unknown) => void>()
  if (internal) internal.busy = () => pendingCalls.size > 0
  const rejectCalls = (err: unknown): void => {
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
    id,
    children: new Set(),
    dispose: () => disposeProcess(),
    settled: () => completion,
  }
  const parent = currentScope
  if (parent !== null) parent.children.add(core)
  sink?.({ type: 'spawn', id, parent: parent && parent.id, name: proc.name, key: internal?.key, args, state: opts?.initial })
  const post = (msg: In): void => {
    sink?.({ type: 'cast', id, msg })
    mailbox.push(msg)
  }

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
      try {
        // inside the try: a throw while binding the parameters is a crash
        const g = (gen = proc(selfFor(mailbox, controller.signal, post), args))
        for (let r = await step(() => g.next()); !r.done; r = await step(() => g.next())) {
          if (phase !== 'running') continue
          sink?.({ type: 'yield', id, ops: reconcile(untracked(src), r.value as unknown as Json) })
          src.publish(r.value as unknown as Json)
          hasValue = true
          errorValue = undefined
          setMeta({ pending: false, stale: false, errored: false })
        }
        if (phase === 'running') transition('done', { pending: false })
      } catch (err) {
        if (phase === 'running') {
          sink?.({ type: 'crash', id, error: err })
          errorValue = err
          controller.abort()
          // queued calls reject with the crash and never reach a restarted
          // instance; queued casts stay and replay
          for (const msg of mailbox.queue.drain()) {
            if (!pendingCalls.has(msg as object)) mailbox.queue.push(msg)
          }
          rejectCalls(err)
          disposeChildren() // the crashed instance's spawns die with it
          // a microtask later: a throwing handler surfaces as an unhandled
          // rejection instead of wedging this loop
          const report = crashHandler
          if (report && !opts?.quiet) void Promise.resolve().then(() => report(err, proc.name))
          if (opts?.restart === 'on-crash' && restarts < (opts.maxRestarts ?? 3)) {
            restarts++
            sink?.({ type: 'restart', id, attempt: restarts })
            setMeta({ pending: true, stale: true, errored: true })
            continue
          }
          transition('crashed', { pending: false, stale: true, errored: true })
        }
      }
      break
    }
    // end of life, any path: generator settled (finally blocks have run)
    gen = null
    mailbox.close()
    // left: calls a body received and never answered (none after a crash)
    rejectCalls(new Error(`nonchalant: process ${phase === 'disposed' ? 'disposed' : 'ended'}`))
    disposeChildren() // owned children die last: mailbox, then finally blocks, then children
    await Promise.all([...childSettlements])
    if (parent !== null) parent.children.delete(core)
    internal?.onSettled?.()
  }

  const disposeProcess = (): void => {
    if (phase !== 'running') {
      if (phase !== 'disposed') transition('disposed', { stale: true })
      disposeChildren()
      return
    }
    transition('disposed', { pending: false, stale: true })
    if (parent !== null) parent.children.delete(core)
    // 1. mailbox closes: body's `for await` ends, queued calls reject. A body
    // parked there resumes in this process's scope, so a `finally` that
    // disposal triggers owns its spawns (drive() disposes them last).
    // Microtasks run FIFO: scope on, the body's resumption, scope off.
    mailbox.close((resolveTakers) => {
      void Promise.resolve().then(() => { currentScope = core })
      resolveTakers()
      void Promise.resolve().then(() => { currentScope = null })
    })
    controller.abort()
    const g = gen!
    void step(() => g.return(undefined as never)).catch(() => {}) // 2. finally blocks run; 3. drive() then disposes children
  }

  completion = drive()

  // ---------- outside face ----------

  const read = (): T | undefined => src() as unknown as T | undefined

  const call = (msg: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (phase !== 'running') {
        reject(new Error(`nonchalant: call on ${phase} process`))
        return
      }
      const ref = sink ? ++lastCall : 0
      sink?.({ type: 'call', id, msg, call: ref })
      const full = {
        ...msg,
        reply: (res: unknown): void => {
          pendingCalls.delete(full)
          sink?.({ type: 'reply', id, call: ref, value: res })
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
  p['cast'] = post
  p['call'] = call
  // the value source is a subtree dep (every yield wakes); the raw snapshot
  // is read untracked so iteration hands out values, not tracking proxies
  p[Symbol.asyncIterator] = (): AsyncIterator<T> =>
    iterate(
      () => {
        void src()
        return hasValue ? (untracked(src) as unknown as T) : NONE
      },
      closers,
      phase === 'running',
    )
  p[Symbol.dispose] = disposeProcess
  p[Symbol.asyncDispose] = async (): Promise<void> => {
    disposeProcess()
    await completion
  }
  return read as unknown as Process<T | undefined, In>
}
