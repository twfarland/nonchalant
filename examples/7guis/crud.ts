// 7GUIs 5/7 — CRUD: one store process, filter and selection as cells,
// the visible list is a keyed thunk hole.

import { cell, spawn } from '@nonchalant/core'
import type { Cast, Proc } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, input, label, option, select } from '@nonchalant/dom/tags'

type Person = { id: number; name: string; surname: string }
type CrudMsg =
  | Cast<{ type: 'create'; name: string; surname: string }>
  | Cast<{ type: 'update'; id: number; name: string; surname: string }>
  | Cast<{ type: 'delete'; id: number }>

const people: Proc<Person[], CrudMsg, void> = async function* (self) {
  let list: Person[] = [
    { id: 1, name: 'Hans', surname: 'Emil' },
    { id: 2, name: 'Max', surname: 'Mustermann' },
    { id: 3, name: 'Roman', surname: 'Tisch' },
  ]
  let nextId = 4
  yield list
  for await (const msg of self) {
    switch (msg.type) {
      case 'create':
        list = [...list, { id: nextId++, name: msg.name, surname: msg.surname }]
        break
      case 'update':
        list = list.map((p) => (p.id === msg.id ? { ...p, name: msg.name, surname: msg.surname } : p))
        break
      case 'delete':
        list = list.filter((p) => p.id !== msg.id)
        break
    }
    yield list
  }
}

const store = spawn(people, undefined, { initial: [] as Person[] })
const prefix = cell('')
const selected = cell(0)
const name = cell('')
const surname = cell('')

const visible = (): Person[] =>
  store().filter((p) => p.surname.toLowerCase().startsWith(prefix().toLowerCase()))

mount(document.getElementById('app')!, div({ class: 'card' },
  div({},
    label({}, 'Filter prefix: '),
    input({ value: prefix, oninput: (e: Event) => prefix.cast((e.target as HTMLInputElement).value) })),
  select({
    size: 5,
    onchange: (e: Event) => {
      const id = Number((e.target as HTMLSelectElement).value)
      selected.cast(id)
      const p = store().find((x) => x.id === id)
      if (p) {
        name.cast(p.name)
        surname.cast(p.surname)
      }
    },
  }, () => visible().map((p) => option({ key: p.id, value: String(p.id) }, `${p.surname}, ${p.name}`))),
  div({},
    label({}, 'Name: '),
    input({ value: name, oninput: (e: Event) => name.cast((e.target as HTMLInputElement).value) }),
    label({}, ' Surname: '),
    input({ value: surname, oninput: (e: Event) => surname.cast((e.target as HTMLInputElement).value) })),
  div({},
    button({ onclick: () => store.cast({ type: 'create', name: name(), surname: surname() }) }, 'Create'),
    button({
      disabled: () => selected() === 0,
      onclick: () => store.cast({ type: 'update', id: selected(), name: name(), surname: surname() }),
    }, 'Update'),
    button({
      disabled: () => selected() === 0,
      onclick: () => {
        store.cast({ type: 'delete', id: selected() })
        selected.cast(0)
      },
    }, 'Delete'))))
