// Query — the userland query client from ../lib/query.ts in action.
// The list and the detail panel are separate queries; renaming is a mutation
// that invalidates both, and every loading/error state you see is just the
// process face of the query or mutation behind it.
//
// Things to try: pick a user (watch the detail load once, then come back —
// it's cached); rename someone (both queries refetch); submit an empty name
// (the mutation rejects and shows its error); press refresh (invalidation).

import { cell } from '@nonchalant/core'
import type { VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, form, h2, input, li, p, span, ul } from '@nonchalant/dom/tags'
import { createQueryClient } from '../lib/query.ts'
import { getUser, listUsers, renameUser } from './api.ts'

const client = createQueryClient({ gcTime: 60_000 })

const usersQuery = () => client.query(['users'], () => listUsers())
const userQuery = (id: number) => client.query(['user', id], () => getUser(id))

const rename = client.mutation(
  ({ id, name }: { id: number; name: string }) => renameUser(id, name),
  { invalidates: (_user, { id }) => [['users'], ['user', id]] },
)

const selected = cell(0)

// ---------- components ----------

const Loading = (when: () => boolean): VNode =>
  span({ class: 'muted', hidden: () => !when() }, ' loading…')

function UserList(): VNode {
  const users = usersQuery()

  return div({},
    h2({}, 'Users', Loading(() => users.pending)),

    ul({ class: 'list' }, () =>
      (users() ?? []).map((u) =>
        li({ key: u.id },
          button({ class: 'linklike', onclick: () => selected.send(u.id) }, u.name)))),

    button({ onclick: () => client.invalidate(['users']) }, 'Refresh'))
}

function UserDetail(): VNode {
  return div({ class: 'detail' }, () => {
    const id = selected()
    if (id === 0) return p({ class: 'muted' }, 'Pick a user.')

    const user = userQuery(id)
    return div({},
      h2({}, () => user()?.name ?? '…', Loading(() => user.pending)),
      p({ class: 'muted' }, () => (user() ? `role: ${user()!.role}` : '')),
      RenameForm(id))
  })
}

function RenameForm(id: number): VNode {
  return form({
      onsubmit: (e: Event) => {
        e.preventDefault()
        const el = (e.target as HTMLFormElement).elements.namedItem('name') as HTMLInputElement
        void rename.mutate({ id, name: el.value }).then(() => (el.value = ''), () => {})
      },
    },
    input({ name: 'name', placeholder: 'new name' }),
    button({ type: 'submit', disabled: () => rename.pending }, () =>
      rename.pending ? 'Renaming…' : 'Rename'),
    span({ class: 'error' }, () => (rename.error !== undefined ? ` ${String(rename.error)}` : '')))
}

// ---------- the page ----------

mount(document.getElementById('app')!, div({ class: 'card' },
  div({ style: 'display: flex; gap: 2rem; flex-wrap: wrap;' },
    UserList(),
    UserDetail())))
