// TodoMVC — one state process (immutable updates, one yield per message),
// one view built from small components. The list is a keyed thunk hole:
// toggling patches one row, the rest of the DOM sleeps.

import { spawn } from '@nonchalant/core'
import type { Proc, Process, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { a, button, div, footer, h1, header, input, label, li, section, span, ul } from '@nonchalant/dom/tags'

// ---------- state ----------

type Todo = { id: number; title: string; done: boolean }
type Filter = 'all' | 'active' | 'completed'
type State = { todos: Todo[]; filter: Filter }

type Msg =
  | { type: 'add'; title: string }
  | { type: 'toggle'; id: number }
  | { type: 'destroy'; id: number }
  | { type: 'toggle-all'; done: boolean }
  | { type: 'clear-completed' }
  | { type: 'filter'; filter: Filter }

const todosProc: Proc<State, Msg, void> = async function* (self) {
  let todos: Todo[] = []
  let filter: Filter = 'all'
  let nextId = 1

  for await (const msg of self) {
    switch (msg.type) {
      case 'add':
        todos = [...todos, { id: nextId++, title: msg.title, done: false }]
        break
      case 'toggle':
        todos = todos.map((t) => (t.id === msg.id ? { ...t, done: !t.done } : t))
        break
      case 'destroy':
        todos = todos.filter((t) => t.id !== msg.id)
        break
      case 'toggle-all':
        todos = todos.map((t) => (t.done === msg.done ? t : { ...t, done: msg.done }))
        break
      case 'clear-completed':
        todos = todos.filter((t) => !t.done)
        break
      case 'filter':
        filter = msg.filter
        break
    }
    yield { todos, filter }
  }
}

type Store = Process<State, Msg>

// ---------- components ----------

function NewTodo(store: Store): VNode {
  return input({
    class: 'new-todo',
    placeholder: 'What needs to be done?',
    autofocus: true,
    onkeydown: (e: KeyboardEvent) => {
      const el = e.target as HTMLInputElement
      const title = el.value.trim()
      if (e.key === 'Enter' && title !== '') {
        store.send({ type: 'add', title })
        el.value = ''
      }
    },
  })
}

function TodoItem(store: Store, todo: Todo): VNode {
  return li({ key: todo.id, class: todo.done ? 'completed' : '' },
    div({ class: 'view' },
      input({
        class: 'toggle',
        type: 'checkbox',
        checked: todo.done,
        onchange: () => store.send({ type: 'toggle', id: todo.id }),
      }),
      label({}, todo.title),
      button({ class: 'destroy', onclick: () => store.send({ type: 'destroy', id: todo.id }) })))
}

function TodoList(store: Store): VNode {
  const visible = (): Todo[] => {
    const { todos, filter } = store()
    if (filter === 'active') return todos.filter((t) => !t.done)
    if (filter === 'completed') return todos.filter((t) => t.done)
    return todos
  }

  return ul({ class: 'todo-list' }, () => visible().map((t) => TodoItem(store, t)))
}

function ToggleAll(store: Store): VNode {
  const remaining = (): number => store().todos.filter((t) => !t.done).length

  return div({},
    input({
      id: 'toggle-all',
      class: 'toggle-all',
      type: 'checkbox',
      checked: () => remaining() === 0 && store().todos.length > 0,
      onchange: (e: Event) =>
        store.send({ type: 'toggle-all', done: (e.target as HTMLInputElement).checked }),
    }),
    label({ for: 'toggle-all' }, 'Mark all as complete'))
}

function FilterLink(store: Store, filter: Filter, text: string): VNode {
  return li({},
    a({
      href: `#/${filter === 'all' ? '' : filter}`,
      class: () => (store().filter === filter ? 'selected' : ''),
      onclick: (e: Event) => {
        e.preventDefault()
        store.send({ type: 'filter', filter })
      },
    }, text))
}

function FooterBar(store: Store): VNode {
  const remaining = (): number => store().todos.filter((t) => !t.done).length

  return footer({ class: 'footer' },
    span({ class: 'todo-count' }, () => {
      const n = remaining()
      return `${n} item${n === 1 ? '' : 's'} left`
    }),

    ul({ class: 'filters' },
      FilterLink(store, 'all', 'All'),
      FilterLink(store, 'active', 'Active'),
      FilterLink(store, 'completed', 'Completed')),

    button({ class: 'clear-completed', onclick: () => store.send({ type: 'clear-completed' }) },
      'Clear completed'))
}

// ---------- the app ----------

function App(store: Store): VNode {
  return section({ class: 'todoapp' },
    header({ class: 'header' },
      h1({}, 'todos'),
      NewTodo(store)),

    section({ class: 'main' },
      ToggleAll(store),
      TodoList(store)),

    FooterBar(store))
}

const store = spawn(todosProc, undefined, { initial: { todos: [], filter: 'all' } as State })
mount(document.getElementById('app')!, App(store))
