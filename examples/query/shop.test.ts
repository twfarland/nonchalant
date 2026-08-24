// The server-state schema, held to its promises headlessly: write-through
// mutations, the explicit ripple, and failure re-sync.

import { describe, it, expect } from 'vitest'
import { shop } from './shop.ts'

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !cond(); i++) await tick(10)
  if (!cond()) throw new Error('condition never became true')
}

describe('the shop schema', () => {
  it('rename is a call: write-through to the user, one ripple to the list', async () => {
    const users = shop.lookup('users')
    const ada = shop.lookup('user', { id: 1 })
    await until(() => users() !== undefined && ada() !== undefined)
    expect(ada().name).toBe('Ada')

    const updated = await ada.call({ type: 'rename', name: 'Ada Lovelace' })
    expect(updated.name).toBe('Ada Lovelace')

    await until(() => ada().name === 'Ada Lovelace') // the yield right behind the reply
    await until(() => users().some((u) => u.name === 'Ada Lovelace')) // the explicit ripple
  }, 15_000)

  it('a failed write rejects the call; the restart policy re-syncs from the server', async () => {
    const ada = shop.lookup('user', { id: 1 })
    await until(() => ada() !== undefined)
    const before = ada().name

    await expect(ada.call({ type: 'rename', name: '' })).rejects.toThrow(/name is required/)
    await until(() => ada.error === undefined && ada.stale === false) // restarted and refetched
    expect(ada().name).toBe(before) // back in sync with the server
  }, 15_000)
})
