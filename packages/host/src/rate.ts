// Lookup rate limiting: the token bucket expose() applies per session, as a
// pure step, and the per-client table that keeps a client's bucket across its
// reconnects — a fresh bucket per connection would let one client refill its
// burst by reconnecting and drain the host-wide bucket for everyone.

import type { RateLimit } from './types.ts'

export interface Bucket {
  readonly tokens: number
  readonly at: number
}

/**
 * Tokens a bucket holds at `now`, capped at the burst. A clock that steps back
 * refills nothing, and NaN must not reach tokens: NaN < 1 never refuses.
 */
export const refilled = (bucket: Bucket, now: number, rate: RateLimit): number => {
  const elapsed = now - bucket.at
  return elapsed > 0 ? Math.min(rate.burst ?? rate.max, bucket.tokens + (elapsed * rate.max) / rate.perMs) : bucket.tokens
}

/** Refill for the time since the last take, then spend one whole token if there is one. A new bucket starts full. */
export function take(bucket: Bucket | undefined, now: number, rate: RateLimit): { ok: boolean; bucket: Bucket } {
  const from = bucket ?? { tokens: rate.burst ?? rate.max, at: now }
  const tokens = refilled(from, now, rate)
  const at = Number.isNaN(now) ? from.at : now
  return tokens < 1 ? { ok: false, bucket: { tokens, at } } : { ok: true, bucket: { tokens: tokens - 1, at } }
}

/** One bucket on the wall clock: a take per call. */
export const bucket = (rate: RateLimit): (() => boolean) => {
  let state: Bucket | undefined
  return () => {
    const r = take(state, Date.now(), rate)
    state = r.bucket
    return r.ok
  }
}

/** A bucket that would have refilled to its burst by `now` is indistinguishable from a new one. */
export const isFull = (bucket: Bucket, now: number, rate: RateLimit): boolean =>
  refilled(bucket, now, rate) >= (rate.burst ?? rate.max)

/** The bucket key for a connection: its scope's principal, else its remote address, else none (a bucket of its own). */
export const clientKey = (principal: string | undefined, address: string | undefined): string | undefined =>
  principal !== undefined ? `principal:${principal}` : address !== undefined ? `address:${address}` : undefined

/**
 * Buckets by client key, in last-use order. Full buckets at the old end are
 * dropped (that loses nothing: a new bucket starts full), and past `cap`
 * entries the least recently used goes regardless.
 */
export function keyedBuckets(rate: RateLimit, cap = 10_000): (key: string, now: number) => boolean {
  const buckets = new Map<string, Bucket>()
  return (key, now) => {
    const { ok, bucket } = take(buckets.get(key), now, rate)
    buckets.delete(key)
    buckets.set(key, bucket)
    for (const [k, b] of buckets) {
      if (buckets.size <= cap && !isFull(b, now, rate)) break
      buckets.delete(k)
    }
    return ok
  }
}
