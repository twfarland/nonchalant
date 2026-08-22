// TodoMVC — the state process lives in todos.ts (where its tests drive it
// directly); this file is the view, built from small components. The list is
// a keyed thunk hole: toggling patches one row, the rest of the DOM sleeps.

import { spawn } from '@nonchalant/core'
import type { Process, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { a, button, div, footer, h1, header, input, label, li, section, span, ul } from '@nonchalant/dom/tags'
import { remaining, todosProc, visible, type Filter, type Msg, type State, type Todo } from './todos.ts'

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
  return ul({ class: 'todo-list' }, () => visible(store()).map((t) => TodoItem(store, t)))
}

function ToggleAll(store: Store): VNode {
  return div({},
    input({
      id: 'toggle-all',
      class: 'toggle-all',
      type: 'checkbox',
      checked: () => remaining(store()) === 0 && store().todos.length > 0,
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
  return footer({ class: 'footer' },
    span({ class: 'todo-count' }, () => {
      const n = remaining(store())
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
