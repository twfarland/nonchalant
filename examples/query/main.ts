// Server state, the process way. TanStack's client shape (a cache, keyed
// fetchers, an invalidation graph) exists because caches are dumb stores that
// must be told what went stale. A process isn't dumb — it OWNS its data:
//
//   - a query is a named definition; lookup gives caching, dedup, sharing,
//     and gc without a client object;
//   - a mutation is an ask() ON THE QUERY ITSELF: it performs the write,
//     replies, and yields the updated state — write-through, no refetch
//     round-trip, no invalidation bookkeeping;
//   - cross-entity ripples are explicit, typed messages (the user process
//     nudges the users list), not a cache-key dependency graph;
//   - loading and failure are the process face: pending covers the first
//     fetch, refreshes, AND in-flight mutations; a failed write crashes the
//     process, the ask rejects, and the restart policy re-syncs from the
//     server automatically.
//
// If you want TanStack's exact API shape anyway (say, mid-migration), it's
// eighty lines of userland: ../lib/query.ts.
//
// Things to try: pick a user (cached on revisit); rename someone (the detail
// updates write-through, the list refreshes); submit an empty name (the ask
// rejects, the error shows, the process re-syncs).

import { cell, define, registry } from '@nonchalant/core'
import type { Call, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, form, h2, input, li, p, span, ul } from '@nonchalant/dom/tags'
import { getUser, listUsers, renameUser, type User } from './api.ts'

// ---------- the schema: queries are definitions ----------

type UsersMsg = { type: 'refresh' }
type UserMsg = { type: 'refresh' } | Call<{ type: 'rename'; name: string }, User>

const shop = registry({
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

const selected = cell(0)

// ---------- components ----------

const Loading = (when: () => boolean): VNode =>
  span({ class: 'muted', hidden: () => !when() }, ' loading…')

function UserList(): VNode {
  const users = shop.lookup('users')

  return div({},
    h2({}, 'Users', Loading(() => users.pending)),

    ul({ class: 'list' }, () =>
      (users() ?? []).map((u) =>
        li({ key: u.id },
          button({ class: 'linklike', onclick: () => selected.send(u.id) }, u.name)))),

    button({ onclick: () => users.send({ type: 'refresh' }) }, 'Refresh'))
}

function UserDetail(): VNode {
  return div({ class: 'detail' }, () => {
    const id = selected()
    if (id === 0) return p({ class: 'muted' }, 'Pick a user.')

    const user = shop.lookup('user', { id })
    return div({},
      h2({}, () => user()?.name ?? '…', Loading(() => user.pending)),
      p({ class: 'muted' }, () => (user() ? `role: ${user()!.role}` : '')),
      RenameForm(id))
  })
}

function RenameForm(id: number): VNode {
  const user = shop.lookup('user', { id })

  const submit = (e: Event): void => {
    e.preventDefault()
    const el = (e.target as HTMLFormElement).elements.namedItem('name') as HTMLInputElement
    void user.ask({ type: 'rename', name: el.value }).then(() => (el.value = ''), () => {})
  }

  return form({ onsubmit: submit },
    input({ name: 'name', placeholder: 'new name' }),
    button({ type: 'submit', disabled: () => user.pending }, () =>
      user.pending ? 'Working…' : 'Rename'),
    span({ class: 'error' }, () => (user.error !== undefined ? ` ${String(user.error)}` : '')))
}

// ---------- the page ----------

mount(document.getElementById('app')!, div({ class: 'card' },
  div({ style: 'display: flex; gap: 2rem; flex-wrap: wrap;' },
    UserList(),
    UserDetail())))
