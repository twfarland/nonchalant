// The query construct, held to TanStack-shaped promises: dedup, sharing,
// loading states, stale-while-refetch, retry-then-stale, invalidation,
// and mutations that reject honestly.

import { describe, it, expect } from 'vitest'
import { createQueryClient } from './query.ts'

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await tick(5)
  if (!cond()) throw new Error('condition never became true')
}

describe('query', () => {
  it('dedups by key, shares data, and stays readable during a refetch', async () => {
    const client = createQueryClient()
    let fetches = 0
    const fetchUsers = async (): Promise<string[]> => {
      fetches++
      await tick(20)
      return [`user-${fetches}`]
    }

    const a = client.query(['users'], fetchUsers)
    const b = client.query(['users'], fetchUsers)
    expect(a).toBe(b) // same key, same process
    expect(a.pending).toBe(true)

    await until(() => a() !== undefined)
    expect(fetches).toBe(1) // one fetch for both holders
    expect(a()).toEqual(['user-1'])
    expect(a.pending).toBe(false)

    client.invalidate(['users'])
    await until(() => a.pending)
    expect(a()).toEqual(['user-1']) // stale-while-refetch: old data still readable
    await until(() => a()?.[0] === 'user-2')
    expect(fetches).toBe(2)
  })

  it('prefix invalidation refetches matching keys only', async () => {
    const client = createQueryClient()
    const counts = { user: 0, other: 0 }
    const u = client.query(['user', 1], async () => {
      counts.user++
      return counts.user
    })
    const o = client.query(['other'], async () => {
      counts.other++
      return counts.other
    })
    await until(() => u() !== undefined && o() !== undefined)

    client.invalidate(['user'])
    await until(() => u() === 2)
    await tick(20)
    expect(counts.other).toBe(1) // untouched

    client.invalidate() // no prefix = everything
    await until(() => o() === 2)
  })

  it('a failing fetch retries, then goes stale with the error on its face', async () => {
    const client = createQueryClient({ retry: 2 })
    let attempts = 0
    const q = client.query(['doomed'], async () => {
      attempts++
      throw new Error('nope')
    })
    await until(() => q.stale && q.error !== undefined)
    expect(attempts).toBe(3) // the first run + 2 retries
    expect(String(q.error)).toMatch(/nope/)
    expect(q()).toBeUndefined() // it never had data to keep
  })

  it('mutations resolve or reject, expose pending/error, and invalidate on success', async () => {
    const client = createQueryClient()
    let version = 1
    const q = client.query(['doc'], async () => `v${version}`)
    await until(() => q() === 'v1')

    const save = client.mutation(
      async ({ value }: { value: string }) => {
        await tick(20)
        if (value === '') throw new Error('empty')
        version++
        return value
      },
      { invalidates: () => [['doc']] },
    )

    const flight = save.mutate({ value: 'hello' })
    await until(() => save.pending)
    await expect(flight).resolves.toBe('hello')
    await until(() => q() === 'v2') // the mutation invalidated the query
    expect(save.last()).toBe('hello')

    await expect(save.mutate({ value: '' })).rejects.toThrow('empty')
    expect(save.error).toBeDefined()

    await expect(save.mutate({ value: 'again' })).resolves.toBe('again') // recovered
    await until(() => save.error === undefined)
  })
})
