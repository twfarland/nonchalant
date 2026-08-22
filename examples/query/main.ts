// Server state, the process way — the schema lives in shop.ts (where its
// tests drive it headlessly); this file is the view. The page itself explains
// why TanStack Query's feature list falls out of the primitives here.
//
// Things to try: pick a user (cached on revisit); rename someone (the detail
// updates write-through, the list refreshes); submit an empty name (the ask
// rejects, the error shows, the process re-syncs from the server).

import { cell } from '@nonchalant/core'
import type { VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, form, h2, input, li, p, span, ul } from '@nonchalant/dom/tags'
import { shop } from './shop.ts'

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
