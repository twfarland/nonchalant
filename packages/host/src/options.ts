// serve()'s limits, validated and defaulted up front: a nonsense limit is a
// startup error, never a host that quietly refuses (or admits) everything.

import type { RateLimit } from './types.ts'

export interface Limits {
  heartbeatMs: number
  maxWatches: number | undefined
  lookupRate: RateLimit
  totalRate: RateLimit
  maxBuffered: number
  maxEntries: number
}

export interface LimitOpts {
  heartbeatMs?: number
  maxWatchesPerConnection?: number
  lookupRate?: RateLimit
  totalLookupRate?: RateLimit
  maxBufferedBytes?: number
  maxEntries?: number
}

// NaN or a zero window would make every refill NaN, and NaN < 1 never refuses
export const checkRate = (option: string, rate: RateLimit): RateLimit => {
  const burst = rate.burst ?? rate.max
  if (!Number.isInteger(rate.max) || rate.max < 0 || !(rate.perMs > 0) || !Number.isInteger(burst) || burst < 0)
    throw new Error(`nonchalant/host: ${option} needs non-negative integer max and burst and a positive perMs`)
  return rate
}

/** The limits serve() runs under; throws naming the first option that makes no sense. */
export function resolveLimits(opts: LimitOpts | undefined): Limits {
  const heartbeatMs = opts?.heartbeatMs ?? 30_000
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 0)
    throw new Error('nonchalant/host: heartbeatMs must be a finite non-negative duration')
  const maxWatches = opts?.maxWatchesPerConnection
  if (maxWatches !== undefined && (!Number.isInteger(maxWatches) || maxWatches < 0))
    throw new Error('nonchalant/host: maxWatchesPerConnection must be a non-negative integer')
  const lookupRate = checkRate('lookupRate', opts?.lookupRate ?? { max: 100, perMs: 10_000, burst: 500 })
  const totalRate = checkRate('totalLookupRate', opts?.totalLookupRate ?? { max: 1_000, perMs: 1_000, burst: 10_000 })
  const maxBuffered = opts?.maxBufferedBytes ?? 8 << 20
  if (!(maxBuffered > 0))
    throw new Error('nonchalant/host: maxBufferedBytes must be positive')
  const maxEntries = opts?.maxEntries ?? 10_000
  if (!(maxEntries > 0) || (Number.isFinite(maxEntries) && !Number.isInteger(maxEntries)))
    throw new Error('nonchalant/host: maxEntries must be a positive integer or Infinity')
  return { heartbeatMs, maxWatches, lookupRate, totalRate, maxBuffered, maxEntries }
}
