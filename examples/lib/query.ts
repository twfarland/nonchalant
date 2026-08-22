// TanStack Query's working core as a userland construct — because a query is
// just a process. What each feature costs here:
//
//   caching + dedup      lookup is get-or-spawn: same key, same process
//   sharing              everyone who looks a key up reads the same yields
//   loading state        q.pending (true during the first fetch AND refetches)
//   stale-while-refetch  the last data stays readable while the next loads
//   errors + retry       a failed fetch crashes the process; restart re-runs
//                        it from the key up to `retry` times, then readers
//                        keep the last data with q.stale and q.error set
//   garbage collection   watcher refcount + `gcTime` idle eviction; the next
//                        lookup after eviction refetches
//   invalidation         a 'refetch' message to every live query whose key
//                        starts with the prefix
//   mutations            an ask(): mutate() resolves or rejects with the
//                        server's answer; m.pending/m.error are the process
//                        faces; success invalidates the keys you name
//
// Deliberately not here: focus/interval refetching (an effect + a timer),
// normalized caches (use a sync engine at that point).

import { define, registry, spawn } from '@nonchalant/core'
import type { Call, Json, Process, Self } from '@nonchalant/core'

export type QueryKey = Json[]
export type Query<T> = Process<T | undefined, 'refetch'>

export interface Mutation<A, R> {
  mutate(args: A): Promise<R>
  readonly pending: boolean
  readonly error: unknown
  /** The last successful result, reactively readable. */
  last: Process<R | undefined>
}

export interface QueryClientOpts {
  /** ms an unwatched query survives before eviction. Default 30s. */
  gcTime?: number
  /** How many times a failing fetch re-runs before going stale. Default 3. */
  retry?: number
}

const canon = (v: Json): Json => {
  if (typeof v !== 'object' || v === null) return v
  if (Array.isArray(v)) return v.map(canon)
  const out: { [k: string]: Json } = {}
  for (const k of Object.keys(v).sort()) out[k] = canon((v as { [k: string]: Json })[k] as Json)
  return out
}
const idOf = (key: Json): string => JSON.stringify(canon(key))

export function createQueryClient(opts?: QueryClientOpts) {
  const fetchers = new Map<string, (signal: AbortSignal) => Promise<Json>>()
  const live = new Map<string, { key: QueryKey; q: Query<Json> }>()

  const reg = registry({
    query: define<Json, 'refetch', Json>(
      async function* (self, key) {
        const fetchOne = fetchers.get(idOf(key))
        if (fetchOne === undefined) throw new Error('query: no fetcher for this key')
        yield await fetchOne(self.signal)
        for await (const _ of self.latest()) yield await fetchOne(self.signal)
      },
      { evict: opts?.gcTime ?? 30_000, restart: 'on-crash', maxRestarts: opts?.retry ?? 3 },
    ),
  })

  const query = <T extends Json>(key: QueryKey, fetchOne: (signal: AbortSignal) => Promise<T>): Query<T> => {
    const id = idOf(key)
    if (!fetchers.has(id)) fetchers.set(id, fetchOne)
    const q = reg.lookup('query', key) as Query<Json>
    live.set(id, { key, q })
    return q as Query<T>
  }

  const matches = (key: QueryKey, prefix: QueryKey): boolean =>
    prefix.length <= key.length && prefix.every((seg, i) => idOf(seg) === idOf(key[i] as Json))

  /** Refetch every live query whose key starts with `prefix` ([] = all). */
  const invalidate = (prefix: QueryKey = []): void => {
    for (const { key, q } of live.values()) if (matches(key, prefix)) q.send('refetch')
  }

  const mutation = <A, R>(
    run: (args: A, signal: AbortSignal) => Promise<R>,
    mopts?: { invalidates?: (result: R, args: A) => QueryKey[] },
  ): Mutation<A, R> => {
    type Req = Call<{ args: A }, R>
    const proc = spawn<R, Req, void>(
      async function* (self: Self<Req>) {
        for await (const msg of self) {
          const value = await run(msg.args, self.signal) // a throw crashes: the ask rejects, error is set
          msg.reply(value)
          yield value
        }
      },
      undefined,
      { restart: 'on-crash', maxRestarts: Number.POSITIVE_INFINITY },
    )
    const asAsk = proc as unknown as { ask(msg: { args: A }): Promise<R> }
    return {
      mutate: async (args) => {
        const value = await asAsk.ask({ args })
        for (const key of mopts?.invalidates?.(value, args) ?? []) invalidate(key)
        return value
      },
      get pending() {
        return proc.pending
      },
      get error() {
        return proc.error
      },
      last: proc as unknown as Process<R | undefined>,
    }
  }

  return { query, invalidate, mutation }
}
