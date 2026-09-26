// The registry: lookup(name, args) is get-or-spawn.
// One operation is simultaneously dependency injection (no prop drilling),
// query caching (name + stable-serialized args = TanStack's queryKey; watcher
// refcount + evict idle timeout = the SWR lifecycle), and — at M6 — remote
// addressing (connect(url) returns the same interface).
//
// Watchers are subscriptions: effects (and derives or iterators an effect
// reads through) reading either process values or lifecycle metadata; the
// graph reports how many watched readers there are, and that is the refcount.
// Plain snapshot pulls, and derives read only as snapshots, are not watching
// (SWR semantics: an evicted entry simply respawns on the next lookup).
// `maxEntries` bounds the cache: past it, the least recently looked-up
// unwatched entries are disposed, so distinct args cannot grow memory without
// bound. Watched entries, and entries holding unanswered calls,
// are never evicted, so a registry whose every entry is
// watched may sit above the cap until watchers leave. Registry processes spawn `unscoped` —
// shared state must not be owned by whichever process looked it up first.

import { spawnProcess, type SpawnHooks, type SpawnOpts } from './process.ts'
import { unscoped } from './scope.ts'
import { keyEncoder } from './key.ts'
import type { ArgsOf, Definition, Proc, Process, Registry } from './types.ts'

const SEP = '\u0000' // separates name from serialized args in cache keys

export interface DefineOpts<T> extends SpawnOpts<T> {
  /**
   * Milliseconds to keep the process alive with no reactive watchers. The timer
   * starts at lookup and restarts when the last watcher leaves. Omit to never
   * auto-evict.
   */
  evict?: number
}

interface RuntimeDef {
  proc: Proc<unknown, unknown, unknown>
  opts: DefineOpts<unknown> | undefined
}

/** Declare a schema entry: the generator a name resolves to, plus its spawn/evict options. `initial` decides T | undefined vs T for lookups. */
export function define<T, In, A>(proc: Proc<T, In, A>, opts: DefineOpts<T> & { initial: T }): Definition<T, In, A, never>
export function define<T, In, A>(proc: Proc<T, In, A>, opts?: DefineOpts<T>): Definition<T, In, A>
export function define<T, In, A>(proc: Proc<T, In, A>, opts?: DefineOpts<T>): Definition<T, In, A> {
  if (opts?.evict !== undefined && (!Number.isFinite(opts.evict) || opts.evict < 0))
    throw new Error('nonchalant: evict must be a finite non-negative duration')
  const def: RuntimeDef = { proc: proc as RuntimeDef['proc'], opts: opts as DefineOpts<unknown> | undefined }
  return def as unknown as Definition<T, In, A>
}

interface Entry {
  process: Process<unknown, unknown>
  timer: ReturnType<typeof setTimeout> | undefined
  watchers: number
  hooks: SpawnHooks
}

/**
 * The capacity policy: keys of entries that may be disposed to make room,
 * least recently looked up first (Map order is recency order). Watched
 * entries, entries holding unanswered calls, and `keep` are never offered.
 * Lazy, so the caller stops as soon as the cache fits.
 */
export function* evictionOrder<E extends Pick<Entry, 'watchers' | 'hooks'>>(entries: Map<string, E>, keep: E): Generator<string> {
  for (const [key, entry] of entries) {
    // evicting an entry holding unanswered calls would reject them under their callers
    if (!entry.watchers && entry !== keep && !entry.hooks.busy?.()) yield key
  }
}

export interface RegistryOpts {
  /** Most entries kept; past it the least recently looked-up unwatched entries are evicted. Omit for no cap. Positive. */
  maxEntries?: number
}

export interface RegistryHandle<S extends { [K in keyof S]: Definition<unknown, unknown, unknown> }>
  extends Registry<S> {
  /** Dispose and forget an entry now — one (name, args) pair, or every entry under the name. */
  evict<K extends keyof S & string>(name: K, ...args: [ArgsOf<S[K]>] extends [void] ? [] : [ArgsOf<S[K]>?]): void
}

/** A local registry over a typed schema. `connect(url)` (M6) returns the same interface remotely. */
export function registry<S extends { [K in keyof S]: Definition<unknown, unknown, unknown> }>(
  defs: S,
  opts?: RegistryOpts,
): RegistryHandle<S> {
  const max = opts?.maxEntries ?? Number.POSITIVE_INFINITY
  if (!(max > 0)) throw new Error('nonchalant: maxEntries must be positive')
  // Map order is recency order: a hit re-inserts its key at the end
  const entries = new Map<string, Entry>()
  const argsKey = keyEncoder()

  const drop = (key: string): void => {
    const entry = entries.get(key)
    if (entry === undefined) return
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entries.delete(key)
    entry.process[Symbol.dispose]()
  }

  // a miss: spawn unscoped, count watchers, run the idle timer if the
  // definition declares one, and forget the entry when its process settles.
  // Callbacks from a superseded entry must not touch its replacement, hence
  // every `entries.get(key) === created` check.
  const open = (name: string, key: string, args: unknown): Entry => {
    const def = defs[name as keyof S] as unknown as RuntimeDef | undefined
    if (def === undefined) throw new Error(`nonchalant: no definition named ${JSON.stringify(name)} in this registry`)
    const evictMs = def.opts?.evict
    const created: Entry = { process: undefined as unknown as Process<unknown, unknown>, timer: undefined, watchers: 0, hooks: {} }
    const onWatchers = (count: number): void => {
      created.watchers = count
      if (evictMs === undefined) return
      if (count > 0) {
        if (created.timer !== undefined) {
          clearTimeout(created.timer)
          created.timer = undefined
        }
      } else if (entries.get(key) === created && created.timer === undefined) {
        created.timer = setTimeout(() => drop(key), evictMs)
      }
    }
    created.process = unscoped(() =>
      spawnProcess(def.proc, args, def.opts, Object.assign(created.hooks, {
        key: name,
        onWatchers,
        onSettled: () => {
          if (entries.get(key) !== created) return
          if (created.timer !== undefined) clearTimeout(created.timer)
          entries.delete(key)
        },
      })),
    ) as Process<unknown, unknown>
    entries.set(key, created)
    onWatchers(0)
    return created
  }

  const lookup = (name: string, ...rest: unknown[]): Process<unknown, unknown> => {
    const args = rest[0]
    const key = name + SEP + argsKey(args)
    let entry = entries.get(key)
    if (entry !== undefined) {
      entries.delete(key)
      entries.set(key, entry)
    } else {
      entry = open(name, key, args)
      if (entries.size > max) {
        for (const victim of evictionOrder(entries, entry)) {
          if (entries.size <= max) break
          drop(victim)
        }
      }
    }
    return entry.process
  }

  const evict = (name: string, ...rest: unknown[]): void => {
    if (rest.length > 0 && rest[0] !== undefined) {
      drop(name + SEP + argsKey(rest[0]))
      return
    }
    const prefix = name + SEP
    for (const key of [...entries.keys()]) if (key.startsWith(prefix)) drop(key)
  }

  return { lookup, evict } as unknown as RegistryHandle<S>
}
