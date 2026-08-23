// `self.latest()` reads the mailbox in skip-to-newest mode: while a search is
// in flight the loop is not listening, and when it comes back it picks up the
// most recent query and drops everything queued in between. No debounce timer,
// no cancellation bookkeeping — the mailbox already has an answer for this.

import { spawn } from '@nonchalant/core'
import type { Proc } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { div, input, li, span, ul } from '@nonchalant/dom/tags'

type State = { q: string; results: string[]; pending: boolean }
type Msg = { q: string }

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
  let results: string[] = []
  yield { q: '', results, pending: false }

  for await (const { q } of self.latest()) {
    yield { q, results, pending: true }
    try {
      results = await search(q, { signal: self.signal })  // self.signal aborts on dispose
      yield { q, results, pending: false }
    } catch {
      /* aborted or failed — keep listening */
    }
  }
}

export function run(host: Element): Disposable {
  const s = spawn(typeahead, undefined, { initial: { q: '', results: [], pending: false } })

  return mount(host, div({ class: 'stack' },
    input({
      type: 'text',
      placeholder: 'type a fruit — the fake API is slow, so type fast',
      oninput: (e: Event) => s.send({ q: (e.target as HTMLInputElement).value }),
    }),
    span({ class: 'muted' }, () => (s().pending ? 'searching…' : `${s().results.length} matches`)),
    ul({ class: 'list' }, () => s().results.slice(0, 6).map((r) => li({ key: r }, r)))))
}
