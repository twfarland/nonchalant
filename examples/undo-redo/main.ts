// Undo/redo — processes compose as functions, so middleware is just function
// composition: no store enhancers, no plugin API. `channel` hands the wrapped
// proc a private Self; the wrapper owns the history.

import { channel, spawn } from '@nonchalant/core'
import type { Cast, Proc, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, span } from '@nonchalant/dom/tags'

type Hist = { type: 'undo' } | { type: 'redo' }

function withHistory<T, In, A>(proc: Proc<T, In, A>, depth = 100): Proc<T, In | Hist, A> {
  return async function* (self, args) {
    const inner = channel<In>(self.signal) // a private Self for the wrapped proc
    const it = proc(inner, args)
    let current = (await it.next()).value as T
    const past: T[] = []
    const future: T[] = []
    yield current
    for await (const msg of self) {
      const m = msg as Hist | In
      // if/else, not a switch: `In` is opaque here, so there is no union to
      // switch over — and an undo with an empty past is not ours to handle,
      // it falls through to the wrapped process like any other message
      if ((m as Hist).type === 'undo' && past.length > 0) {
        future.push(current)
        current = past.pop() as T
      } else if ((m as Hist).type === 'redo' && future.length > 0) {
        past.push(current)
        current = future.pop() as T
      } else {
        past.push(current)
        if (past.length > depth) past.shift()
        future.length = 0
        inner.cast(m as In)
        current = (await it.next()).value as T // convention: one yield per message
      }
      yield current
    }
  }
}

type CounterMsg = Cast<{ type: 'add'; n: number }>

const counter: Proc<number, CounterMsg, void> = async function* (self) {
  let n = 0
  yield n
  for await (const msg of self) {
    n += msg.n
    yield n
  }
}

function App(): VNode {
  const count = spawn(withHistory(counter), undefined, { initial: 0 })
  return div({ class: 'card' },
    button({ onclick: () => count.cast({ type: 'add', n: 1 }) }, '+1'),
    span({ class: 'value' }, count),
    button({ onclick: () => count.cast({ type: 'undo' }) }, 'undo'),
    button({ onclick: () => count.cast({ type: 'redo' }) }, 'redo'))
}

mount(document.getElementById('app')!, App())
