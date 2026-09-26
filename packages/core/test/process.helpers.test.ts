// The runtime's pure pieces as plain functions: option validation, the
// metadata merge, and the reply bookkeeping for calls.

import { describe, it, expect } from 'vitest'
import { nextMeta, validateSpawnOpts, type Meta, type SpawnOpts } from '../src/process.ts'
import { rejectAll, rejectDropped, retainCasts, type PendingCalls } from '../src/calls.ts'
import { Fifo } from '../src/mailbox.ts'

describe('validateSpawnOpts', () => {
  const accepted: [string, SpawnOpts<unknown> | undefined][] = [
    ['no options', undefined],
    ['empty options', {}],
    ['a mailbox of 0', { mailbox: 0 }],
    ['a mailbox of 5', { mailbox: 5 }],
    ['maxRestarts of 0', { maxRestarts: 0 }],
    ['maxRestarts of 10', { maxRestarts: 10 }],
    ['maxRestarts of Infinity', { maxRestarts: Number.POSITIVE_INFINITY }],
    ['options it does not check', { initial: 1, restart: 'on-crash', quiet: true }],
  ]
  for (const [label, opts] of accepted) {
    it(`accepts ${label}`, () => {
      expect(() => validateSpawnOpts(opts)).not.toThrow()
    })
  }

  const mailboxError = 'nonchalant: mailbox must be a non-negative integer'
  const restartError = 'nonchalant: maxRestarts must be a non-negative integer or Infinity'
  const rejected: [string, SpawnOpts<unknown>, string][] = [
    ['a negative mailbox', { mailbox: -1 }, mailboxError],
    ['a fractional mailbox', { mailbox: 1.5 }, mailboxError],
    ['a NaN mailbox', { mailbox: Number.NaN }, mailboxError],
    ['an Infinity mailbox', { mailbox: Number.POSITIVE_INFINITY }, mailboxError],
    ['negative maxRestarts', { maxRestarts: -1 }, restartError],
    ['fractional maxRestarts', { maxRestarts: 0.5 }, restartError],
    ['NaN maxRestarts', { maxRestarts: Number.NaN }, restartError],
    ['-Infinity maxRestarts', { maxRestarts: Number.NEGATIVE_INFINITY }, restartError],
  ]
  for (const [label, opts, message] of rejected) {
    it(`rejects ${label}`, () => {
      expect(() => validateSpawnOpts(opts)).toThrow(message)
    })
  }

  it('checks the mailbox before the restart budget', () => {
    expect(() => validateSpawnOpts({ mailbox: -1, maxRestarts: -1 })).toThrow(mailboxError)
  })
})

describe('nextMeta', () => {
  const idle: Meta = { pending: false, stale: false, errored: false }

  it('returns the same object when the patch changes no flag', () => {
    expect(nextMeta(idle, {})).toBe(idle)
    expect(nextMeta(idle, { pending: false })).toBe(idle)
    expect(nextMeta(idle, { pending: false, stale: false, errored: false })).toBe(idle)
  })

  it('returns a new object with the patch applied when any flag changes', () => {
    const next = nextMeta(idle, { pending: true })
    expect(next).not.toBe(idle)
    expect(next).toStrictEqual({ pending: true, stale: false, errored: false })
    expect(idle).toStrictEqual({ pending: false, stale: false, errored: false })
  })

  it('applies several flags at once', () => {
    expect(nextMeta(idle, { stale: true, errored: true })).toStrictEqual({ pending: false, stale: true, errored: true })
  })
})

describe('reply bookkeeping', () => {
  // a pending table whose rejections land in `log`
  const table = (...keys: object[]): { pending: PendingCalls; log: [object, unknown][] } => {
    const pending: PendingCalls = new Map()
    const log: [object, unknown][] = []
    for (const key of keys) pending.set(key, (err) => log.push([key, err]))
    return { pending, log }
  }

  it('rejectAll rejects every pending call with the error, then forgets them', () => {
    const a = {}
    const b = {}
    const { pending, log } = table(a, b)
    const err = new Error('gone')
    rejectAll(pending, err)
    expect(log).toStrictEqual([[a, err], [b, err]])
    expect(pending.size).toBe(0)
  })

  it('rejectDropped rejects a dropped call once and forgets it', () => {
    const call = {}
    const { pending, log } = table(call)
    rejectDropped(pending, call)
    rejectDropped(pending, call)
    expect(log).toHaveLength(1)
    expect((log[0]![1] as Error).message).toBe('nonchalant: call dropped — mailbox overflow or process ended')
    expect(pending.size).toBe(0)
  })

  it('rejectDropped ignores casts, object or primitive', () => {
    const call = {}
    const { pending, log } = table(call)
    rejectDropped(pending, { type: 'cast' })
    rejectDropped(pending, 7)
    expect(log).toStrictEqual([])
    expect(pending.size).toBe(1)
  })

  it('retainCasts removes queued calls and keeps casts in order, leaving the calls pending', () => {
    const c1 = { type: 'ask' }
    const c2 = { type: 'ask' }
    const { pending, log } = table(c1, c2)
    const queue = new Fifo<unknown>()
    for (const msg of ['a', c1, 'b', c2, 'c']) queue.push(msg)
    queue.shift() // a consumed prefix does not come back
    retainCasts(queue, pending)
    expect(queue.drain()).toStrictEqual(['b', 'c'])
    expect(log).toStrictEqual([])
    expect(pending.size).toBe(2)
  })
})
