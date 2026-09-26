// A search box has to decide what happens to input that arrives while a search
// is running. This one does two things: a new query aborts the search in
// flight, and an answer to any query but the newest is dropped, not shown.
// The search runs beside the loop and reports back with a self-cast, so the
// mailbox stays open while it waits.

import { spawn } from '@nonchalant/core'
import type { Cast, Proc } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { div, input, li, span, ul } from '@nonchalant/dom/tags'

type State = { q: string; results: string[]; pending: boolean }
type Msg =
  | Cast<{ type: 'query'; q: string }>
  | Cast<{ type: 'found'; seq: number; results: string[] }>

const FRUIT = [
  'apricot', 'banana', 'blackberry', 'blueberry', 'cherry', 'clementine',
  'cranberry', 'elderberry', 'fig', 'gooseberry', 'grape', 'grapefruit',
  'guava', 'kiwi', 'lemon', 'lime', 'lychee', 'mandarin', 'mango', 'melon',
  'nectarine', 'orange', 'papaya', 'peach', 'pear', 'persimmon', 'pineapple',
  'plum', 'pomegranate', 'quince', 'raspberry', 'strawberry', 'tangerine',
]

// stands in for a network call: slow, and abortable
const search = (q: string, opts: { signal: AbortSignal }): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(FRUIT.filter((f) => f.includes(q.toLowerCase()))), 400)
    opts.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })

const typeahead: Proc<State, Msg, void> = async function* (self) {
  let s: State = { q: '', results: [], pending: false }
  let seq = 0                            // which query the box is showing
  let inflight = new AbortController()
  yield s

  for await (const msg of self) {
    switch (msg.type) {
      case 'query': {
        inflight.abort()                 // cancel the search in flight
        inflight = new AbortController()
        const mine = ++seq
        search(msg.q, { signal: AbortSignal.any([self.signal, inflight.signal]) }).then(
          (results) => self.cast({ type: 'found', seq: mine, results }),
          () => {},                      // aborted: a newer query or disposal
        )
        s = { ...s, q: msg.q, pending: true }
        break
      }
      case 'found':
        if (msg.seq !== seq) continue    // answered after a newer query: drop it
        s = { ...s, results: msg.results, pending: false }
        break
    }
    yield s
  }
}

export function run(host: Element): Disposable {
  const s = spawn(typeahead, undefined, { initial: { q: '', results: [], pending: false } })

  return mount(host, div({ class: 'stack' },
    input({
      type: 'text',
      placeholder: 'type a fruit — the fake API is slow, so type fast',
      oninput: (e) => s.cast({ type: 'query', q: e.currentTarget.value }),
    }),
    span({ class: 'muted' }, () => (s().pending ? 'searching…' : `${s().results.length} matches`)),
    ul({ class: 'list' }, () => s().results.slice(0, 6).map((r) => li({ key: r }, r)))))
}
