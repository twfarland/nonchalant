// One process owns the list. The message type is a discriminated union, the
// generator body is the reducer, and every update is `let` + spread — so rows
// that did not change keep their identity, and toggling one row patches one
// row. Nothing else in the DOM is touched.

import { spawn } from '@nonchalant/core'
import type { Proc, Process, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, input, li, span, ul } from '@nonchalant/dom/tags'

type Todo = { id: number; title: string; done: boolean }
type State = { todos: Todo[]; nextId: number }
type Msg =
  | { type: 'add'; title: string }
  | { type: 'toggle'; id: number }
  | { type: 'remove'; id: number }

const initial: State = {
  todos: [
    { id: 1, title: 'read the tutorial', done: true },
    { id: 2, title: 'spawn a process', done: false },
  ],
  nextId: 3,
}

const todos: Proc<State, Msg, void> = async function* (self) {
  let s = initial
  yield s
  for await (const msg of self) {
    if (msg.type === 'add')
      s = { todos: [...s.todos, { id: s.nextId, title: msg.title, done: false }], nextId: s.nextId + 1 }
    else if (msg.type === 'toggle')
      s = { ...s, todos: s.todos.map((t) => (t.id === msg.id ? { ...t, done: !t.done } : t)) }
    else
      s = { ...s, todos: s.todos.filter((t) => t.id !== msg.id) }
    yield s
  }
}

function Row(store: Process<State, Msg>, todo: Todo): VNode {
  return li({ key: todo.id },
    input({
      type: 'checkbox',
      checked: todo.done,
      onchange: () => store.send({ type: 'toggle', id: todo.id }),
    }),
    span({ class: todo.done ? 'done' : '' }, todo.title),
    button({ onclick: () => store.send({ type: 'remove', id: todo.id }) }, 'remove'))
}

export function run(host: Element): Disposable {
  const store = spawn(todos, undefined, { initial })

  return mount(host, div({ class: 'stack' },
    input({
      type: 'text',
      placeholder: 'add a todo, then press Enter',
      onkeydown: (e: KeyboardEvent) => {
        const el = e.target as HTMLInputElement
        const title = el.value.trim()
        if (e.key === 'Enter' && title !== '') {
          store.send({ type: 'add', title })
          el.value = ''
        }
      },
    }),
    // the list is a keyed thunk hole: this runs again only when todos change
    ul({ class: 'list' }, () => store().todos.map((t) => Row(store, t)))))
}
