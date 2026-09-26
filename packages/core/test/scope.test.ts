// Ambient ownership on its own: which scope is current, when, and for how long.

import { describe, it, expect } from 'vitest'
import { currentScope, resumeWithin, unscoped, withScope, type ProcessCore } from '../src/scope.ts'

const core = (id: number): ProcessCore => ({
  id,
  children: new Set(),
  dispose: () => {},
  settled: () => Promise.resolve(),
})

describe('withScope', () => {
  it('makes the scope current for the call and restores the previous one after', () => {
    const a = core(1)
    const b = core(2)
    const seen: (number | undefined)[] = []
    withScope(a, () => {
      seen.push(currentScope?.id)
      withScope(b, () => seen.push(currentScope?.id))
      seen.push(currentScope?.id)
    })
    expect(seen).toStrictEqual([1, 2, 1])
    expect(currentScope).toBeNull()
  })

  it('returns what fn returns', () => {
    expect(withScope(core(1), () => 42)).toBe(42)
  })

  it('restores the previous scope when fn throws', () => {
    const a = core(1)
    withScope(a, () => {
      expect(() => withScope(core(2), () => { throw new Error('boom') })).toThrow('boom')
      expect(currentScope).toBe(a)
    })
    expect(currentScope).toBeNull()
  })

  it('covers only the synchronous part of an async fn', async () => {
    const seen: (number | undefined)[] = []
    await withScope(core(1), async () => {
      seen.push(currentScope?.id)
      await Promise.resolve()
      seen.push(currentScope?.id)
    })
    expect(seen).toStrictEqual([1, undefined])
  })
})

describe('unscoped', () => {
  it('suspends the current scope for the call only', () => {
    const a = core(1)
    const seen: (ProcessCore | null)[] = []
    withScope(a, () => {
      seen.push(unscoped(() => currentScope))
      seen.push(currentScope)
    })
    expect(seen).toStrictEqual([null, a])
  })
})

describe('resumeWithin', () => {
  it('runs the reactions of what resolve settles inside the scope, and clears it after', async () => {
    const a = core(1)
    let release!: () => void
    const parked = new Promise<void>((resolve) => { release = resolve })
    const seen: (number | undefined)[] = []
    const resumed = parked.then(() => seen.push(currentScope?.id))
    resumeWithin(a, release)
    expect(currentScope).toBeNull() // nothing changes synchronously
    await resumed
    await Promise.resolve()
    expect(seen).toStrictEqual([1])
    expect(currentScope).toBeNull()
  })

  it('leaves reactions queued before it outside the scope', async () => {
    const seen: (number | undefined)[] = []
    const earlier = Promise.resolve().then(() => seen.push(currentScope?.id))
    resumeWithin(core(1), () => {})
    await earlier
    expect(seen).toStrictEqual([undefined])
  })
})
