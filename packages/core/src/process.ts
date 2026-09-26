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
//
// Collaborators: the mailbox (`mailbox.ts`), ambient ownership (`scope.ts`),
// reply bookkeeping (`calls.ts`), the observation slots (`instrument.ts`).

import { source, untracked } from './graph.ts'
import { iterate, NONE } from './iterate.ts'
import { reconcile, type Json } from './reconcile.ts'
import { Mailbox, selfFor } from './mailbox.ts'
import { currentScope, resumeWithin, withScope, type ProcessCore } from './scope.ts'
import { crashHandler, sink } from './instrument.ts'
import { rejectAll, rejectDropped, retainCasts, type PendingCalls } from './calls.ts'
import type { Proc, Process } from './types.ts'

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

/** What the registry hands spawnProcess; `busy` is written back for it to poll. */
export interface SpawnHooks {
  onWatchers?: (count: number) => void
  onSettled?: () => void
  busy?: () => boolean
  key?: string
}

// ---------- options ----------

/** Throw on a malformed mailbox bound or restart budget. */
export function validateSpawnOpts(opts: SpawnOpts<unknown> | undefined): void {
  const bound = opts?.mailbox
  if (bound !== undefined && (!Number.isInteger(bound) || bound < 0))
    throw new Error('nonchalant: mailbox must be a non-negative integer')
  const max = opts?.maxRestarts
  if (max !== undefined && max !== Number.POSITIVE_INFINITY && (!Number.isInteger(max) || max < 0))
    throw new Error('nonchalant: maxRestarts must be a non-negative integer or Infinity')
}

// ---------- meta ----------

export type Meta = { pending: boolean; stale: boolean; errored: boolean }
type Phase = 'running' | 'done' | 'crashed' | 'disposed'

/** `current` with `patch` applied — or `current` itself when no flag changes,
 * so a no-op transition publishes nothing. */
export function nextMeta(current: Meta, patch: Partial<Meta>): Meta {
  const next = { ...current, ...patch }
  return next.pending === current.pending && next.stale === current.stale && next.errored === current.errored
    ? current
    : next
}

// ---------- spawn ----------

let lastId = 0
let lastCall = 0

export function spawnProcess<T, In, A>(
  proc: Proc<T, In, A>,
  args: A,
  opts?: SpawnOpts<T>,
  internal?: SpawnHooks,
): Process<T | undefined, In> {
  validateSpawnOpts(opts)

  // the registry's refcount is the sum: either kind of subscription, to
  // values or to lifecycle, keeps a shared process alive
  const report = internal?.onWatchers
  let valueWatchers = 0
  let metaWatchers = 0
  const src = source<Json>(
    opts?.initial as unknown as Json,
    report && { onWatchers: (count) => report((valueWatchers = count) + metaWatchers) },
  )
  let m: Meta = { pending: true, stale: false, errored: false }
  const meta = source<Meta>(m, report && { onWatchers: (count) => report(valueWatchers + (metaWatchers = count)) })
  const id = ++lastId
  const setMeta = (patch: Partial<Meta>): void => {
    const next = nextMeta(m, patch)
    if (next === m) return
    m = next
    sink?.({ type: 'status', id, ...next })
    meta.publish(next)
  }

  let phase: Phase = 'running'
  let errorValue: unknown
  let hasValue = opts !== undefined && 'initial' in opts
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

  const pendingCalls: PendingCalls = new Map()
  if (internal) internal.busy = () => pendingCalls.size > 0

  const mailbox = new Mailbox<In>({
    bound: opts?.mailbox,
    onDrop: (msg) => rejectDropped(pendingCalls, msg),
    onDeliver: () => setMeta({ pending: true }),
    onIdle: () => setMeta({ pending: false }),
  })

  // ---------- ownership ----------

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

  // ---------- the drive loop ----------

  // scope window: body code runs synchronously inside this call until its
  // first await/yield — spawns in that window attach to this process
  const step = (g: AsyncGenerator<T>): Promise<IteratorResult<T>> => withScope(core, () => g.next())

  const publish = (value: T): void => {
    if (phase !== 'running') return
    sink?.({ type: 'yield', id, ops: reconcile(untracked(src), value as unknown as Json) })
    src.publish(value as unknown as Json)
    hasValue = true
    errorValue = undefined
    setMeta({ pending: false, stale: false, errored: false })
  }

  // a throw while running; true when the process restarts
  const crash = (err: unknown): boolean => {
    sink?.({ type: 'crash', id, error: err })
    errorValue = err
    controller.abort()
    // queued calls reject with the crash and never reach a restarted
    // instance; queued casts stay and replay
    retainCasts(mailbox.queue, pendingCalls)
    rejectAll(pendingCalls, err)
    disposeChildren() // the crashed instance's spawns die with it
    // a microtask later: a throwing handler surfaces as an unhandled
    // rejection instead of wedging the drive loop
    const report = crashHandler
    if (report && !opts?.quiet) void Promise.resolve().then(() => report(err, proc.name))
    if (opts?.restart === 'on-crash' && restarts < (opts.maxRestarts ?? 3)) {
      restarts++
      sink?.({ type: 'restart', id, attempt: restarts })
      setMeta({ pending: true, stale: true, errored: true })
      return true
    }
    transition('crashed', { pending: false, stale: true, errored: true })
    return false
  }

  const drive = async (): Promise<void> => {
    for (let restart = true; restart;) {
      restart = false
      controller = new AbortController()
      try {
        // inside the try: a throw while binding the parameters is a crash
        const g = (gen = proc(selfFor(mailbox, controller.signal, post), args))
        for (let r = await step(g); !r.done; r = await step(g)) publish(r.value)
        if (phase === 'running') transition('done', { pending: false })
      } catch (err) {
        if (phase === 'running') restart = crash(err)
      }
    }
    // end of life, any path: generator settled (finally blocks have run)
    gen = null
    mailbox.close()
    // left: calls a body received and never answered (none after a crash)
    rejectAll(pendingCalls, new Error(`nonchalant: process ${phase === 'disposed' ? 'disposed' : 'ended'}`))
    disposeChildren() // owned children die last: mailbox, then finally blocks, then children
    await Promise.all([...childSettlements])
    if (parent !== null) parent.children.delete(core)
    internal?.onSettled?.()
  }

  // ---------- disposal ----------

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
    mailbox.close((resolveTakers) => resumeWithin(core, resolveTakers))
    controller.abort()
    // 2. finally blocks run; 3. drive() then disposes children
    void withScope(core, () => gen!.return(undefined as never)).catch(() => {})
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
