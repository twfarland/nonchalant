// The replay rules as plain functions: migration on load, recorded steps
// answering a re-run, the attempt counter, what of a call is written down,
// and the journaled sleep's abortable delay.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Json } from '@nonchalant/core'
import { nextAttempt, plainly, recall, restore } from '../src/replay.ts'
import { delay } from '../src/durable.ts'
import type { StepRecord } from '../src/store.ts'

const loaded = (snapshot: Json | undefined, version: number) => ({ snapshot, version, cursor: 0, epoch: 1 })

describe('restore', () => {
  it('hands back a snapshot committed under the current version as it is', () => {
    const snapshot = { n: 1 }
    expect(restore(loaded(snapshot, 2), 2, undefined, 'k')).toBe(snapshot)
  })

  it('is undefined for a key that never committed, whatever the versions', () => {
    expect(restore(loaded(undefined, 0), 5, undefined, 'k')).toBe(undefined)
  })

  it('migrates an older snapshot, telling migrate the version it came from', () => {
    const migrate = vi.fn((old: Json, from: number) => ({ was: old, from }))
    expect(restore(loaded({ n: 1 }, 1), 3, migrate, 'k')).toStrictEqual({ was: { n: 1 }, from: 1 })
    expect(migrate).toHaveBeenCalledTimes(1)
  })

  it('refuses an older snapshot when there is no migrate', () => {
    expect(() => restore(loaded({ n: 1 }, 1), 2, undefined, 'k'))
      .toThrow("nonchalant/durable: no migrate for 'k' from version 1 to 2")
  })

  it('keeps a null snapshot, which is a committed state and not the absence of one', () => {
    expect(restore(loaded(null, 0), 0, undefined, 'k')).toBe(null)
  })
})

describe('recall', () => {
  const recorded: StepRecord[] = [
    { index: 0, name: 'charge', result: 'r1' },
    { index: -1, name: 'attempt', result: 'Error: boom' },
    { index: 1, name: 'ship', result: null },
  ]

  it('answers a step already recorded at that index', () => {
    expect(recall(recorded, 1, 'ship', 'k', 7)).toStrictEqual({ index: 1, name: 'ship', result: null })
  })

  it('is undefined for a step not yet recorded', () => {
    expect(recall(recorded, 2, 'notify', 'k', 7)).toBe(undefined)
    expect(recall([], 0, 'charge', 'k', 7)).toBe(undefined)
  })

  it('throws when the step at that index was recorded under another name', () => {
    expect(() => recall(recorded, 0, 'refund', 'k', 7))
      .toThrow("nonchalant/durable: step order drifted in 'k' #7: step 0 was 'charge', now 'refund'")
  })

  it('does not mistake a failed attempt for a step', () => {
    expect(recall([{ index: -1, name: 'attempt', result: 'x' }], 0, 'charge', 'k', 1)).toBe(undefined)
  })
})

describe('nextAttempt', () => {
  const attempts = (n: number): StepRecord[] => Array.from({ length: n }, (_, i) => ({ index: -(i + 1), name: 'attempt', result: 'e' }))

  it('counts only the failed attempts, not the steps', () => {
    expect(nextAttempt([{ index: 0, name: 'charge', result: 1 }, ...attempts(1)], 5)).toBe(2)
  })

  it('records attempts 1 to maxAttempts - 1, then dead-letters', () => {
    expect([0, 1, 2].map((n) => nextAttempt(attempts(n), 3))).toStrictEqual([1, 2, undefined])
  })

  it('dead-letters on the first crash when one attempt is allowed', () => {
    expect(nextAttempt([], 1)).toBe(undefined)
  })

  it('never dead-letters with no limit', () => {
    expect(nextAttempt(attempts(1000), Infinity)).toBe(1001)
  })
})

describe('plainly', () => {
  it('drops the reply and keeps everything else', () => {
    const msg = { type: 'charge', callId: 'c1', amount: 5, reply: () => {} }
    expect(plainly(msg)).toStrictEqual({ type: 'charge', callId: 'c1', amount: 5 })
  })

  it('copies rather than changing the message it was given', () => {
    const msg = { type: 'x', reply: () => {} }
    plainly(msg)
    expect(typeof msg.reply).toBe('function')
  })
})

describe('delay', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves after the time and leaves no listener on the signal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    let done = false
    const p = delay(100, controller.signal).then(() => (done = true))
    vi.advanceTimersByTime(99)
    await Promise.resolve()
    expect(done).toBe(false)
    vi.advanceTimersByTime(1)
    await p
    expect(done).toBe(true)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('rejects with the abort reason when aborted mid-wait, and clears its timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const controller = new AbortController()
    const p = delay(100, controller.signal)
    controller.abort('disposed')
    await expect(p).rejects.toBe('disposed')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects at once on a signal already aborted', async () => {
    const controller = new AbortController()
    controller.abort('gone')
    await expect(delay(100, controller.signal)).rejects.toBe('gone')
  })
})
