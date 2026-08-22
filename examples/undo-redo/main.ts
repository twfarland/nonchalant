// Undo/redo — processes compose as functions, so middleware is function
// composition (docs/design-proposal §07): no store enhancers, no plugin API.
// `channel` hands the wrapped proc a private Self; the wrapper owns history.

import { channel, spawn } from '@nonchalant/core'
import type { Proc, VNode } from '@nonchalant/core'
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
        inner.send(m as In)
        current = (await it.next()).value as T // convention: one yield per message
      }
      yield current
    }
  }
}

type CounterMsg = { type: 'add'; n: number }

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
  return div({},
    button({ onclick: () => count.send({ type: 'add', n: 1 }) }, '+1'),
    span({ class: 'value' }, count),
    button({ onclick: () => count.send({ type: 'undo' }) }, 'undo'),
    button({ onclick: () => count.send({ type: 'redo' }) }, 'redo'))
}

mount(document.getElementById('app')!, App())
