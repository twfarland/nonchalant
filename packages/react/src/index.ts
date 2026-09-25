// @nonchalant/react — React as the renderer, processes as the state. Every
// hook is a useSyncExternalStore over one core `effect`, so reads are
// tearing-free and a component subscribes to exactly the paths it read.
//
// StrictMode runs subscribe → unsubscribe → subscribe; each subscription owns
// its own effect (and, for useDerive, its own derive), so nothing survives an
// unsubscribe. useSpawn is the one hook that creates a process during render
// and is the one that needs the claim protocol below.

import { derive, effect, spawn, untracked } from '@nonchalant/core'
import type { Proc, Process, ProcessBase, SpawnOpts } from '@nonchalant/core'
import { useEffect, useMemo, useReducer, useState, useSyncExternalStore } from 'react'
import type { DependencyList } from 'react'

interface Store<T> {
  subscribe(onChange: () => void): () => void
  get(): T
}

/** An effect that runs `read` tracked and calls `onChange` on every wake after the first run. */
const watch = (read: () => void, onChange: () => void): (() => void) => {
  let first = true
  return effect(() => {
    read()
    if (first) first = false
    else untracked(onChange)
  })
}

const useStore = <T>(store: Store<T>): T => useSyncExternalStore(store.subscribe, store.get, store.get)

// ---------- reading ----------

/** The process's current value; re-renders on every yield. For part of it, use `useDerive`. */
export function useProcess<T>(p: ProcessBase<T>): T {
  const store = useMemo<Store<T>>(() => ({
    subscribe: (onChange) => watch(() => void p(), onChange),
    get: () => untracked(p),
  }), [p])
  return useStore(store)
}

/**
 * A derived value over any processes. The component re-renders only when the
 * result changes, and the result is recomputed only when a path `fn` read
 * changed. `deps` lists the render-scope values `fn` closes over, as for useMemo.
 */
export function useDerive<T>(fn: () => T, deps: DependencyList): T {
  const store = useMemo(() => selection(fn), deps)
  return useStore(store)
}

function selection<T>(fn: () => T): Store<T> {
  let live: Process<T> | undefined
  let holders = 0
  let first: { value: T } | undefined
  return {
    subscribe(onChange) {
      const d = (live ??= derive(fn))
      holders++
      const stop = watch(() => {
        try {
          void d()
        } catch {
          // still tracked; get() rethrows it into the render
        }
      }, onChange)
      return () => {
        stop()
        if (--holders === 0) {
          live = undefined
          d[Symbol.dispose]()
        }
      }
    },
    get() {
      if (live !== undefined) return untracked(live)
      // before the first subscription: a snapshot, cached so a selector that
      // builds a fresh object does not read as a change on every call
      first ??= { value: untracked(fn) }
      return first.value
    },
  }
}

export interface Meta {
  /** Working towards its next yield. */
  readonly pending: boolean
  /** The value survives a crash, a partition, or disposal. */
  readonly stale: boolean
  /** The last failure, if any. */
  readonly error: unknown
}

/** A process's lifecycle metadata. The object keeps its identity until a field changes. */
export function useProcessMeta(p: ProcessBase<unknown>): Meta {
  const store = useMemo<Store<Meta>>(() => {
    let last: Meta | undefined
    return {
      subscribe: (onChange) => watch(() => void [p.pending, p.stale, p.error], onChange),
      get: () => untracked(() => {
        const { pending, stale, error } = p
        if (last?.pending !== pending || last.stale !== stale || last.error !== error) last = { pending, stale, error }
        return last
      }),
    }
  }, [p])
  return useStore(store)
}

// ---------- owning ----------

// A process spawned during render is claimed when its component commits. One
// that is never claimed — StrictMode's discarded second render, or a render
// React threw away — is disposed after GRACE. A commit later than that finds
// its process disposed and spawns a fresh one, so the grace trades a rare
// restart for never leaking.
const GRACE = 1_000

interface Slot<P> {
  readonly p: P
  claims: number
  over: boolean
}

const release = (slot: Slot<Disposable>): void => {
  if (slot.claims > 0 || slot.over) return
  slot.over = true
  slot.p[Symbol.dispose]()
}

const hold = <P extends Disposable>(p: P): Slot<P> => {
  const slot: Slot<P> = { p, claims: 0, over: false }
  setTimeout(() => release(slot), GRACE)
  return slot
}

/**
 * A process owned by this component: spawned on first render, disposed on
 * unmount. `args` and `opts` are read once; to start over with new ones, give
 * the component a new `key`.
 */
export function useSpawn<T, In, A>(proc: Proc<T, In, A>, args: A, opts: SpawnOpts<T> & { initial: T }): Process<T, In>
export function useSpawn<T, In, A>(proc: Proc<T, In, A>, args: A, opts?: SpawnOpts<T>): Process<T | undefined, In>
export function useSpawn<T, In, A>(proc: Proc<T, In, A>, args: A, opts?: SpawnOpts<T>): Process<T | undefined, In> {
  const start = (): Slot<Process<T | undefined, In>> => hold(spawn(proc, args, opts))
  const [slot, setSlot] = useState(start)
  useEffect(() => {
    if (slot.over) {
      setSlot(start())
      return
    }
    slot.claims++
    return () => {
      slot.claims--
      // StrictMode's re-run reclaims it in the same task; an unmount does not
      void Promise.resolve().then(() => release(slot))
    }
  }, [slot])
  return slot.p
}

/**
 * A registry lookup for a component: `useLookup(() => shop.lookup('cart', { id }))`.
 * The entry stays alive while the component is mounted (idle eviction and the
 * LRU cap skip it, even if the component only casts), and if it is evicted
 * anyway the component re-renders and the lookup runs again. The lookup is a
 * thunk so its own typing (names, args, `T | undefined`) passes through as is;
 * it works the same over `connect(url)`.
 */
export function useLookup<P extends ProcessBase<unknown>>(lookup: () => P): P {
  const [, relook] = useReducer((n: number) => n + 1, 0)
  const p = lookup()
  useEffect(() => watch(() => void p.stale, () => {
    if (untracked(() => p.stale)) relook()
  }), [p])
  return p
}
