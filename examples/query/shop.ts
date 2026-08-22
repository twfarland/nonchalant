// The schema — server state as process definitions, no view code. Kept apart
// from main.ts so shop.test.ts can exercise it headlessly.

import { define, registry } from '@nonchalant/core'
import type { Call } from '@nonchalant/core'
import { getUser, listUsers, renameUser, type User } from './api.ts'

export type UsersMsg = { type: 'refresh' }
export type UserMsg = { type: 'refresh' } | Call<{ type: 'rename'; name: string }, User>

export const shop = registry({
  users: define<{ id: number; name: string }[], UsersMsg, void>(
    async function* (self) {
      yield await listUsers()
      for await (const _ of self.latest()) yield await listUsers()
    },
    { evict: 60_000, restart: 'on-crash' },
  ),

  user: define<User, UserMsg, { id: number }>(
    async function* (self, { id }) {
      yield await getUser(id)
      for await (const msg of self) {
        if (msg.type === 'refresh') {
          yield await getUser(id)
        } else {
          const updated = await renameUser(id, msg.name) // a throw rejects the ask; restart re-syncs
          msg.reply(updated)
          yield updated // write-through: the new state, no refetch
          shop.lookup('users').send({ type: 'refresh' }) // the one explicit ripple
        }
      }
    },
    { evict: 60_000, restart: 'on-crash' },
  ),
})
