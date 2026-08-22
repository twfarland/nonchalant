// The registry (docs/DECISIONS.md #10): lookup(name, args) is get-or-spawn.
// One operation is simultaneously dependency injection (no prop drilling),
// query caching (name + stable-serialized args = TanStack's queryKey; watcher
// refcount + evict idle timeout = the SWR lifecycle), and — at M6 — remote
// addressing (connect(url) returns the same interface).
//
// Watchers are subscriptions: every effect/derive/iterator reading the process
// creates a gate on its value source, and the gate count is the refcount.
// Plain snapshot pulls are not watching (SWR semantics: an evicted entry
// simply respawns on the next lookup). Registry processes spawn `unscoped` —
// shared state must not be owned by whichever process looked it up first.

import { spawnProcess, unscoped, type SpawnOpts } from './process.ts'
import type { ArgsOf, Definition, Proc, Process, Registry } from './types.ts'

const SEP = '\u0000' // separates name from serialized args in cache keys

export interface DefineOpts<T> extends SpawnOpts<T> {
  /**
   * Milliseconds to keep the process alive after its last watcher unsubscribes;
   * the timer cancels if a watcher returns. Omit to never auto-evict.
   */
  evict?: number
}

interface RuntimeDef {
  proc: Proc<unknown, unknown, unknown>
  opts: DefineOpts<unknown> | undefined
}

/** Declare a schema entry: the generator a name resolves to, plus its spawn/evict options. */
export function define<T, In, A>(proc: Proc<T, In, A>, opts?: DefineOpts<T>): Definition<T, In, A> {
  const def: RuntimeDef = { proc: proc as RuntimeDef['proc'], opts: opts as DefineOpts<unknown> | undefined }
  return def as unknown as Definition<T, In, A>
}

// stable serialization: {a,b} and {b,a} are the same key (queryKey semantics)
const canon = (v: unknown): unknown => {
  if (typeof v !== 'object' || v === null) return v
  if (Array.isArray(v)) return v.map(canon)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v).sort()) out[k] = canon((v as Record<string, unknown>)[k])
  return out
}
const argsKey = (args: unknown): string => (args === undefined ? '' : JSON.stringify(canon(args)))

interface Entry {
  process: Process<unknown, unknown>
  timer: ReturnType<typeof setTimeout> | undefined
}

export interface RegistryHandle<S extends { [K in keyof S]: Definition<unknown, unknown, unknown> }>
  extends Registry<S> {
  /** Dispose and forget an entry now — one (name, args) pair, or every entry under the name. */
  evict<K extends keyof S & string>(name: K, ...args: [ArgsOf<S[K]>] extends [void] ? [] : [ArgsOf<S[K]>?]): void
}

/** A local registry over a typed schema. `connect(url)` (M6) returns the same interface remotely. */
export function registry<S extends { [K in keyof S]: Definition<unknown, unknown, unknown> }>(
  defs: S,
): RegistryHandle<S> {
  const entries = new Map<string, Entry>()

  const drop = (key: string): void => {
    const entry = entries.get(key)
    if (entry === undefined) return
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entries.delete(key)
    entry.process[Symbol.dispose]()
  }

  const lookup = (name: string, ...rest: unknown[]): Process<unknown, unknown> => {
    const args = rest[0]
    const key = name + SEP + argsKey(args)
    let entry = entries.get(key)
    if (entry === undefined) {
      const def = defs[name as keyof S] as unknown as RuntimeDef | undefined
      if (def === undefined) throw new Error(`nonchalant: no definition named ${JSON.stringify(name)} in this registry`)
      const evictMs = def.opts?.evict
      const created: Entry = { process: undefined as unknown as Process<unknown, unknown>, timer: undefined }
      const onWatchers =
        evictMs === undefined
          ? undefined
          : (count: number): void => {
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
        spawnProcess(def.proc, args, def.opts, onWatchers !== undefined ? { onWatchers } : undefined),
      ) as Process<unknown, unknown>
      entry = created
      entries.set(key, entry)
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
