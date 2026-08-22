// Typeahead — cancellation and racing via the mailbox's two iteration modes
// (docs/design-proposal §07). `latest()` gives flatMapLatest's behaviour:
// while the fetch is in flight the loop is not listening; on completion it
// resumes at the newest pending query, skipping everything between. The
// abort signal cancels the in-flight request on dispose.

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

  for await (const { q } of self.latest()) { // stale keystrokes never even arrive
    yield { q, results, pending: true }
    try {
      results = await api.search(q, { signal: self.signal })
      yield { q, results, pending: false }
    } catch {
      /* aborted or failed; the loop simply continues */
    }
  }
}

const api: Api = {
  search: async (q, { signal }) => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal })
    return (await res.json()) as Result[]
  },
}

const services = registry({ search: define(search, { initial: { q: '', results: [], pending: false } }) })

function Typeahead(): VNode {
  const s = services.lookup('search', { api })
  return div({ class: 'typeahead' },
    input({
      placeholder: 'Search…',
      oninput: (e: Event) => s.send({ q: (e.target as HTMLInputElement).value }),
    }),
    span({ class: 'spinner', hidden: () => !s().pending }),
    ul({}, () => s().results.map((r) => li({ key: r.title }, r.title))))
}

mount(document.getElementById('app')!, Typeahead())
