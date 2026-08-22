// Typeahead. `self.latest()` skips straight to the newest query — while a
// search is in flight the loop isn't listening, and stale keystrokes never
// even arrive. The abort signal cancels in-flight work on dispose.
//
// The "API" here is a fake with realistic latency so the demo is
// self-contained. Swap in a real fetch and pass `self.signal` to it.

import { registry, define } from '@nonchalant/core'
import type { Proc, Self, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { div, input, li, span, ul } from '@nonchalant/dom/tags'

type Result = { title: string }
type Api = { search(q: string, opts: { signal: AbortSignal }): Promise<Result[]> }
type Query = { q: string }
type SearchState = { q: string; results: Result[]; pending: boolean }

const search: Proc<SearchState, Query, { api: Api }> = async function* (self: Self<Query>, { api }) {
  let results: Result[] = []
  yield { q: '', results, pending: false }

  for await (const { q } of self.latest()) {
    yield { q, results, pending: true }
    try {
      results = await api.search(q, { signal: self.signal })
      yield { q, results, pending: false }
    } catch {
      /* aborted or failed; the loop simply continues */
    }
  }
}

// a fake search API: ~300ms latency over a local word list
const WORDS = 'nonchalant process mailbox registry reconcile signal snapshot patch transport socket channel keyboard canvas sprite gravity physics'.split(' ')
const api: Api = {
  search: (q, { signal }) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const needle = q.trim().toLowerCase()
        resolve(needle === '' ? [] : WORDS.filter((w) => w.includes(needle)).map((w) => ({ title: w })))
      }, 300)
      signal.addEventListener('abort', () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      })
    }),
}

const services = registry({ search: define(search, { initial: { q: '', results: [], pending: false } }) })

function Typeahead(): VNode {
  const s = services.lookup('search', { api })
  return div({ class: 'card' },
    input({
      placeholder: 'Type to search…',
      oninput: (e: Event) => s.send({ q: (e.target as HTMLInputElement).value }),
    }),
    span({ class: 'muted', hidden: () => !s().pending }, ' searching…'),
    ul({ class: 'list' }, () => s().results.map((r) => li({ key: r.title }, r.title))))
}

mount(document.getElementById('app')!, Typeahead())
