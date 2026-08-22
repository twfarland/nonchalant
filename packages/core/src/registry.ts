// The registry: lookup(name, args) is get-or-spawn.
// One operation is simultaneously dependency injection (no prop drilling),
// query caching (name + stable-serialized args = TanStack's queryKey; watcher
// refcount + evict idle timeout = the SWR lifecycle), and — at M6 — remote
// addressing (connect(url) returns the same interface).
//
// Watchers are subscriptions: effects/derives/iterators reading either process
// values or lifecycle metadata create gates, and their total is the refcount.
// Plain snapshot pulls are not watching (SWR semantics: an evicted entry
// simply respawns on the next lookup). Registry processes spawn `unscoped` —
// shared state must not be owned by whichever process looked it up first.

import { spawnProcess, unscoped, type SpawnOpts } from './process.ts'
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

/** Declare a schema entry: the generator a name resolves to, plus its spawn/evict options. */
export function define<T, In, A>(proc: Proc<T, In, A>, opts?: DefineOpts<T>): Definition<T, In, A> {
  if (opts?.evict !== undefined && (!Number.isFinite(opts.evict) || opts.evict < 0))
    throw new Error('nonchalant: evict must be a finite non-negative duration')
  const def: RuntimeDef = { proc: proc as RuntimeDef['proc'], opts: opts as DefineOpts<unknown> | undefined }
  return def as unknown as Definition<T, In, A>
}

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
  const objectIds = new WeakMap<object, number>()
  const symbolIds = new Map<symbol, number>()
  let nextIdentity = 0

  const objectIdentity = (value: object): number => {
    let id = objectIds.get(value)
    if (id === undefined) {
      id = ++nextIdentity
      objectIds.set(value, id)
    }
    return id
  }

  const encodeArg = (value: unknown, ancestors: Set<object>): string => {
    if (value === null) return 'null'
    switch (typeof value) {
      case 'undefined': return 'undefined'
      case 'boolean': return value ? 'true' : 'false'
      case 'string': return `string:${JSON.stringify(value)}`
      case 'number':
        if (Number.isNaN(value)) return 'number:NaN'
        if (value === Number.POSITIVE_INFINITY) return 'number:Infinity'
        if (value === Number.NEGATIVE_INFINITY) return 'number:-Infinity'
        if (Object.is(value, -0)) return 'number:-0'
        return `number:${value}`
      case 'bigint': return `bigint:${value}`
      case 'symbol': {
        let id = symbolIds.get(value)
        if (id === undefined) {
          id = ++nextIdentity
          symbolIds.set(value, id)
        }
        return `symbol:${id}`
      }
      case 'function': return `function:${objectIdentity(value)}`
      case 'object': break
    }

    const object = value as object
    if (ancestors.has(object)) return `cycle:${objectIdentity(object)}`
    const proto = Object.getPrototypeOf(object)
    const plain = proto === Object.prototype || proto === null
    if (!Array.isArray(object) && (!plain || Object.getOwnPropertySymbols(object).length > 0))
      return `object:${objectIdentity(object)}`

    ancestors.add(object)
    try {
      if (Array.isArray(object)) {
        const values: string[] = []
        for (let i = 0; i < object.length; i++)
          values.push(Object.hasOwn(object, i) ? encodeArg(object[i], ancestors) : 'hole')
        return `array:[${values.join(',')}]`
      }
      const record = object as Record<string, unknown>
      return `record:{${Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${encodeArg(record[key], ancestors)}`).join(',')}}`
    } finally {
      ancestors.delete(object)
    }
  }

  const argsKey = (args: unknown): string => encodeArg(args, new Set())

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
        spawnProcess(def.proc, args, def.opts, {
          ...(onWatchers !== undefined ? { onWatchers } : {}),
          onSettled: () => {
            if (entries.get(key) !== created) return
            if (created.timer !== undefined) clearTimeout(created.timer)
            entries.delete(key)
          },
        }),
      ) as Process<unknown, unknown>
      entry = created
      entries.set(key, entry)
      onWatchers?.(0)
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
