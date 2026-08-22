// @nonchalant/core — public surface. Types are final (draft 3, verified);
// runtime implemented through M4 (reconcile, graph, processes, generic mount).
// The registry (M5) and wire (M6) land per docs/ROADMAP.md.

export type {
  Call, Plain, Requests, Res,
  Process, ProcessBase, Self, Proc,
  Definition, Schema, Registry, ProcessOf, ArgsOf,
  VNode, Slot, Sink,
} from './types.ts'
export { reconcile, applyPatch } from './reconcile.ts'
export type { Json, Op, Patch } from './reconcile.ts'
export { flush, effect, untracked } from './graph.ts'
export { channel } from './process.ts'
export type { SpawnOpts } from './process.ts'
export { define, registry } from './registry.ts'
export type { DefineOpts, RegistryHandle } from './registry.ts'

import { computed, effect } from './graph.ts'
import { spawnProcess, type SpawnOpts } from './process.ts'
import type { Proc, Process, ProcessBase, Self, Sink as SinkT } from './types.ts'

/** Run an async generator as a supervised local process. `initial` decides T | undefined vs T. */
export function spawn<T, In, A>(proc: Proc<T, In, A>, args: A, opts: SpawnOpts<T> & { initial: T }): Process<T, In>
export function spawn<T, In, A>(proc: Proc<T, In, A>, args: A, opts?: SpawnOpts<T>): Process<T | undefined, In>
export function spawn<T, In, A>(proc: Proc<T, In, A>, args: A, opts?: SpawnOpts<T>): Process<T | undefined, In> {
  return spawnProcess(proc, args, opts)
}

/** A pure memoised computation over other processes. No mailbox. */
export function derive<T>(fn: () => T): Process<T> {
  let error: unknown
  const wrapped = (): T => {
    try {
      const v = fn()
      error = undefined
      return v
    } catch (e) {
      error = e
      throw e
    }
  }
  const c = computed(wrapped)
  let disposed = false
  const closers = new Set<() => void>()

  const read = (): T => {
    if (disposed) return c.peek() as T
    const v = c.read()
    // a failed update leaves the graph clean with the stale value; keep throwing
    // until a recompute succeeds and clears `error`
    if (error !== undefined) throw error
    return v
  }

  const asyncIterator = (): AsyncIterator<T> => {
    let buffered = false
    let latest: T | undefined
    let failure: unknown
    let failed = false
    let done = disposed
    let wake: (() => void) | undefined
    const signalWake = (): void => {
      const w = wake
      wake = undefined
      if (w) w()
    }
    let stop = (): void => {}
    if (!done) {
      stop = effect(() => {
        try {
          latest = read()
          buffered = true
        } catch (e) {
          failure = e
          failed = true
        }
        signalWake()
      })
    }
    const finish = (): void => {
      if (!done) {
        done = true
        stop()
        closers.delete(finish)
        signalWake()
      }
    }
    closers.add(finish)
    return {
      async next(): Promise<IteratorResult<T>> {
        while (!buffered && !failed && !done) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
        if (failed) {
          failed = false
          const e = failure
          failure = undefined
          finish()
          throw e
        }
        if (buffered) {
          buffered = false
          return { value: latest as T, done: false }
        }
        return { value: undefined as never, done: true }
      },
      async return(): Promise<IteratorResult<T>> {
        finish()
        return { value: undefined as never, done: true }
      },
    }
  }

  Object.defineProperties(read, {
    pending: { get: () => false },
    stale: { get: () => disposed },
    error: { get: () => error },
  })
  const withSymbols = read as unknown as Record<symbol, unknown>
  withSymbols[Symbol.asyncIterator] = asyncIterator
  withSymbols[Symbol.dispose] = (): void => {
    if (disposed) return
    disposed = true
    for (const finish of [...closers]) finish()
    c.dispose()
  }
  return read as unknown as Process<T>
}

/** Attach a view (a value or a process of values) to a sink. Disposal unbinds everything beneath. */
export function mount<Out>(sink: SinkT<Out>, view: ProcessBase<Out | undefined> | Out): Disposable {
  return sink.mount(view)
}

/**
 * Not a primitive — acknowledged sugar for transient widget state (the useState case).
 * A cell is a leaf process whose messages are its next values.
 */
export function cell<T>(initial: T): Process<T, T> {
  return spawn<T, T, void>(
    async function* (self: Self<T>) {
      for await (const next of self) yield next
    },
    undefined,
    { initial },
  )
}
