// The host's pure pieces as plain functions: option validation, the token
// bucket and the per-client table, the upgrade gate, and the session's lookup
// path. The end-to-end behaviour over sockets is host.test.ts.

import { describe, it, expect } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { Exposable } from '@nonchalant/wire'
import { checkRate, resolveLimits } from '../src/options.ts'
import { clientKey, isFull, keyedBuckets, take, type Bucket } from '../src/rate.ts'
import { originAllowed, refusal, screenUpgrade } from '../src/http.ts'
import { sessionGate } from '../src/session.ts'

// ---------- options ----------

describe('resolveLimits', () => {
  it('fills every default when given nothing', () => {
    expect(resolveLimits(undefined)).toStrictEqual({
      heartbeatMs: 30_000,
      maxWatches: undefined,
      lookupRate: { max: 100, perMs: 10_000, burst: 500 },
      totalRate: { max: 1_000, perMs: 1_000, burst: 10_000 },
      maxBuffered: 8 << 20,
      maxEntries: 10_000,
    })
  })

  it('passes sensible values through untouched', () => {
    const lookupRate = { max: 1, perMs: 1 }
    const limits = resolveLimits({ heartbeatMs: 0, maxWatchesPerConnection: 0, lookupRate, maxBufferedBytes: 1, maxEntries: Infinity })
    expect(limits.heartbeatMs).toBe(0)
    expect(limits.maxWatches).toBe(0)
    expect(limits.lookupRate).toBe(lookupRate)
    expect(limits.maxBuffered).toBe(1)
    expect(limits.maxEntries).toBe(Infinity)
  })

  const refusals: [name: string, opts: Parameters<typeof resolveLimits>[0], names: string][] = [
    ['negative heartbeat', { heartbeatMs: -1 }, 'heartbeatMs'],
    ['NaN heartbeat', { heartbeatMs: Number.NaN }, 'heartbeatMs'],
    ['infinite heartbeat', { heartbeatMs: Infinity }, 'heartbeatMs'],
    ['fractional watch cap', { maxWatchesPerConnection: 1.5 }, 'maxWatchesPerConnection'],
    ['negative watch cap', { maxWatchesPerConnection: -1 }, 'maxWatchesPerConnection'],
    ['zero rate window', { lookupRate: { max: 1, perMs: 0 } }, 'lookupRate'],
    ['fractional total burst', { totalLookupRate: { max: 1, perMs: 1, burst: 0.5 } }, 'totalLookupRate'],
    ['zero buffer', { maxBufferedBytes: 0 }, 'maxBufferedBytes'],
    ['NaN buffer', { maxBufferedBytes: Number.NaN }, 'maxBufferedBytes'],
    ['zero entries', { maxEntries: 0 }, 'maxEntries'],
    ['fractional entries', { maxEntries: 2.5 }, 'maxEntries'],
  ]
  for (const [name, opts, names] of refusals)
    it(`refuses a ${name}, naming ${names}`, () => {
      expect(() => resolveLimits(opts)).toThrow(`nonchalant/host: ${names} `)
    })
})

describe('checkRate', () => {
  it('returns the rate itself when it is valid, burst or not', () => {
    const rate = { max: 0, perMs: 0.5 }
    expect(checkRate('r', rate)).toBe(rate)
    const bursty = { max: 3, perMs: 10, burst: 0 }
    expect(checkRate('r', bursty)).toBe(bursty)
  })

  const bad: [string, { max: number; perMs: number; burst?: number }][] = [
    ['fractional max', { max: 0.5, perMs: 10 }],
    ['negative max', { max: -1, perMs: 10 }],
    ['NaN max', { max: Number.NaN, perMs: 10 }],
    ['zero window', { max: 1, perMs: 0 }],
    ['NaN window', { max: 1, perMs: Number.NaN }],
    ['negative burst', { max: 1, perMs: 10, burst: -1 }],
    ['fractional burst', { max: 1, perMs: 10, burst: 1.5 }],
  ]
  for (const [name, rate] of bad)
    it(`refuses a ${name} under the option's name`, () => {
      expect(() => checkRate('someRate', rate)).toThrow(
        'nonchalant/host: someRate needs non-negative integer max and burst and a positive perMs',
      )
    })
})

// ---------- the token bucket ----------

const rate = { max: 2, perMs: 1_000, burst: 4 } // one token per 500 ms, four at most

describe('take', () => {
  it('starts a new bucket full and spends one token', () => {
    expect(take(undefined, 100, rate)).toStrictEqual({ ok: true, bucket: { tokens: 3, at: 100 } })
  })

  it('refuses once fewer than one whole token is left, keeping the fraction', () => {
    const r = take({ tokens: 0.5, at: 0 }, 0, rate)
    expect(r).toStrictEqual({ ok: false, bucket: { tokens: 0.5, at: 0 } })
  })

  it('refills evenly with elapsed time', () => {
    expect(take({ tokens: 0, at: 0 }, 500, rate)).toStrictEqual({ ok: true, bucket: { tokens: 0, at: 500 } })
    expect(take({ tokens: 0, at: 0 }, 250, rate)).toStrictEqual({ ok: false, bucket: { tokens: 0.5, at: 250 } })
  })

  it('caps the refill at the burst', () => {
    expect(take({ tokens: 1, at: 0 }, 1_000_000, rate)).toStrictEqual({ ok: true, bucket: { tokens: 3, at: 1_000_000 } })
  })

  it('defaults the burst to max', () => {
    expect(take(undefined, 0, { max: 1, perMs: 10 })).toStrictEqual({ ok: true, bucket: { tokens: 0, at: 0 } })
    expect(take({ tokens: 0, at: 0 }, 1_000, { max: 1, perMs: 10 }).bucket.tokens).toBe(0)
  })

  it('refills nothing when the clock steps back, and resumes from the new time', () => {
    const back = take({ tokens: 1.5, at: 1_000 }, 400, rate)
    expect(back).toStrictEqual({ ok: true, bucket: { tokens: 0.5, at: 400 } })
    expect(take(back.bucket, 650, rate)).toStrictEqual({ ok: true, bucket: { tokens: 0, at: 650 } })
  })

  it('a NaN clock neither refills nor poisons the bucket', () => {
    const r = take({ tokens: 0.5, at: 10 }, Number.NaN, rate)
    expect(r).toStrictEqual({ ok: false, bucket: { tokens: 0.5, at: 10 } })
    expect(take(r.bucket, 510, rate).ok).toBe(true)
  })

  it('a zero-rate bucket spends its burst and never refills', () => {
    const none = { max: 0, perMs: 1, burst: 1 }
    const first = take(undefined, 0, none)
    expect(first.ok).toBe(true)
    expect(take(first.bucket, 1e12, none)).toStrictEqual({ ok: false, bucket: { tokens: 0, at: 1e12 } })
  })

  it('a zero burst refuses everything', () => {
    expect(take(undefined, 0, { max: 5, perMs: 1, burst: 0 }).ok).toBe(false)
  })
})

describe('isFull', () => {
  it('is true exactly when the refill would reach the burst', () => {
    const b: Bucket = { tokens: 2, at: 0 }
    expect(isFull(b, 999, rate)).toBe(false)
    expect(isFull(b, 1_000, rate)).toBe(true)
  })

  it('does not count time from a clock that stepped back', () => {
    expect(isFull({ tokens: 3, at: 1_000 }, 0, rate)).toBe(false)
    expect(isFull({ tokens: 4, at: 1_000 }, 0, rate)).toBe(true)
  })
})

describe('clientKey', () => {
  it('prefers the principal, then the address, and keeps the two namespaces apart', () => {
    expect(clientKey('alice', '10.0.0.1')).toBe('principal:alice')
    expect(clientKey(undefined, '10.0.0.1')).toBe('address:10.0.0.1')
    expect(clientKey('10.0.0.1', undefined)).not.toBe(clientKey(undefined, '10.0.0.1'))
    expect(clientKey(undefined, undefined)).toBeUndefined()
  })
})

describe('keyedBuckets', () => {
  it('keeps one bucket per key, independent of the others', () => {
    const takeFor = keyedBuckets({ max: 1, perMs: 1_000_000, burst: 2 })
    expect([takeFor('a', 0), takeFor('a', 0), takeFor('a', 0)]).toStrictEqual([true, true, false])
    expect([takeFor('b', 0), takeFor('b', 0), takeFor('b', 0)]).toStrictEqual([true, true, false])
  })

  it('drops a bucket once it has refilled, which a new bucket reproduces exactly', () => {
    const takeFor = keyedBuckets({ max: 1, perMs: 100, burst: 1 })
    expect(takeFor('a', 0)).toBe(true)
    expect(takeFor('a', 50)).toBe(false)
    expect(takeFor('b', 200)).toBe(true) // sweeps 'a', which is full again
    expect(takeFor('a', 200)).toBe(true)
    expect(takeFor('a', 200)).toBe(false)
  })

  it('past the cap forgets the least recently used client', () => {
    const takeFor = keyedBuckets({ max: 0, perMs: 1, burst: 1 }, 2)
    expect([takeFor('a', 0), takeFor('b', 0), takeFor('a', 0)]).toStrictEqual([true, true, false])
    expect(takeFor('c', 0)).toBe(true) // evicts 'b', the least recently used
    expect(takeFor('a', 0)).toBe(false) // 'a' was used more recently, so kept
    expect(takeFor('b', 0)).toBe(true) // a fresh bucket
  })
})

// ---------- the upgrade gate ----------

const request = (url: string, origin?: string): IncomingMessage =>
  ({ url, headers: origin === undefined ? {} : { origin } }) as unknown as IncomingMessage

describe('originAllowed', () => {
  const req = request('/')
  it('with no policy allows every origin, even none', async () => {
    expect(await originAllowed(undefined, undefined, req)).toBe(true)
  })
  it('with a list allows exactly the listed origins and never a missing one', async () => {
    expect(await originAllowed(['https://a.example'], 'https://a.example', req)).toBe(true)
    expect(await originAllowed(['https://a.example'], 'https://b.example', req)).toBe(false)
    expect(await originAllowed(['https://a.example'], undefined, req)).toBe(false)
  })
  it('with a function defers to it, passing a missing origin as undefined', async () => {
    const seen: (string | undefined)[] = []
    const policy = async (origin: string | undefined): Promise<boolean> => {
      seen.push(origin)
      return origin === undefined
    }
    expect(await originAllowed(policy, undefined, req)).toBe(true)
    expect(await originAllowed(policy, 'https://a.example', req)).toBe(false)
    expect(seen).toStrictEqual([undefined, 'https://a.example'])
  })
})

describe('screenUpgrade', () => {
  const yes = async (): Promise<boolean> => true
  const no = async (): Promise<boolean> => false

  it('accepts a request that passes path, origin, and authorization', async () => {
    expect(await screenUpgrade(request('/ws?t=1', 'https://a.example'), '/ws', ['https://a.example'], yes)).toBeUndefined()
  })

  it('answers the first failing check: path 404, then origin 403, then authorization 401', async () => {
    let asked = 0
    const counting = async (): Promise<boolean> => {
      asked++
      return false
    }
    expect(await screenUpgrade(request('/elsewhere', 'https://b.example'), '/ws', ['https://a.example'], counting)).toBe(404)
    expect(await screenUpgrade(request('/ws', 'https://b.example'), '/ws', ['https://a.example'], counting)).toBe(403)
    expect(asked).toBe(0)
    expect(await screenUpgrade(request('/ws', 'https://a.example'), '/ws', ['https://a.example'], no)).toBe(401)
  })

  it('lets a throwing authorize reject, for the caller to answer 500', async () => {
    const boom = async (): Promise<boolean> => {
      throw new Error('down')
    }
    await expect(screenUpgrade(request('/'), '/', undefined, boom)).rejects.toThrow('down')
  })
})

describe('refusal', () => {
  it('is a complete, closing HTTP response with the standard reason phrase', () => {
    expect(refusal(401)).toBe('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    expect(refusal(403)).toContain('403 Forbidden\r\n')
    expect(refusal(404)).toContain('404 Not Found\r\n')
    expect(refusal(500)).toContain('500 Internal Server Error\r\n')
  })
})

// ---------- the session's lookup path ----------

describe('sessionGate', () => {
  const gateOf = (extra: Partial<Exposable> = {}): { gate: Exposable; looked: unknown[][] } => {
    const looked: unknown[][] = []
    return { looked, gate: { lookup: (...a: unknown[]) => { looked.push(a); return 'proc' }, ...extra } }
  }

  it('checks the client bucket, then the host bucket, then looks up', () => {
    const { gate, looked } = gateOf()
    const order: string[] = []
    const s = sessionGate(gate, () => { order.push('client'); return true }, () => { order.push('host'); return true })
    expect(s.lookup('cart', { id: 1 })).toBe('proc')
    expect(order).toStrictEqual(['client', 'host'])
    expect(looked).toStrictEqual([['cart', { id: 1 }]])
  })

  it('an empty client bucket raises without spending a host token', () => {
    const { gate, looked } = gateOf()
    let host = 0
    const s = sessionGate(gate, () => false, () => { host++; return true })
    expect(() => s.lookup('cart')).toThrow(/^lookup rate exceeded$/)
    expect(host).toBe(0)
    expect(looked).toStrictEqual([])
  })

  it('an empty host bucket raises the host-wide message', () => {
    const { gate } = gateOf()
    expect(() => sessionGate(gate, () => true, () => false).lookup('cart')).toThrow(/^host lookup rate exceeded$/)
  })

  it('keeps the gate principal, or mints a distinct one per session', () => {
    expect(sessionGate(gateOf({ principal: 'alice' }).gate, () => true, () => true).principal).toBe('alice')
    const a = sessionGate(gateOf().gate, () => true, () => true).principal
    const b = sessionGate(gateOf().gate, () => true, () => true).principal
    expect(typeof a).toBe('string')
    expect(a).not.toBe(b)
  })

  it('carries admit over bound to the gate, and adds none when the gate has none', () => {
    const gate = {
      lookup: () => undefined,
      prefix: 'ok:',
      admit(this: { prefix: string }, name: string) { return this.prefix + name },
    }
    const s = sessionGate(gate, () => true, () => true)
    expect(s.admit?.('cart', { type: 'x' })).toBe('ok:cart')
    expect('admit' in sessionGate(gateOf().gate, () => true, () => true)).toBe(false)
  })
})
