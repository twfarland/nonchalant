// The todos process and its pure helpers — separated from the view so tests
// can drive the generator directly (see todos.test.ts).

import type { Cast, Proc } from '@nonchalant/core'

export type Todo = { id: number; title: string; done: boolean }
export type Filter = 'all' | 'active' | 'completed'
export type State = { todos: Todo[]; filter: Filter }

export type Msg =
  | Cast<{ type: 'add'; title: string }>
  | Cast<{ type: 'toggle'; id: number }>
  | Cast<{ type: 'destroy'; id: number }>
  | Cast<{ type: 'toggle-all'; done: boolean }>
  | Cast<{ type: 'clear-completed' }>
  | Cast<{ type: 'filter'; filter: Filter }>

export const todosProc: Proc<State, Msg, void> = async function* (self) {
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

export const visible = ({ todos, filter }: State): Todo[] => {
  if (filter === 'active') return todos.filter((t) => !t.done)
  if (filter === 'completed') return todos.filter((t) => t.done)
  return todos
}

export const remaining = (state: State): number => state.todos.filter((t) => !t.done).length
