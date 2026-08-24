// The smallest process there is: state is a `let`, input is `for await`,
// output is `yield`. Messages are deltas rather than computed values, so the
// arithmetic happens in one place and in order — click as fast as you like and
// nothing races, because the mailbox serializes the work by default.

import { spawn } from '@nonchalant/core'
import type { Self } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, span } from '@nonchalant/dom/tags'

export function run(host: Element): Disposable {
  const counter = spawn(async function* (self: Self<number>) {
    let n = 0                          // this is the state
    yield n
    for await (const d of self) {      // this is the input
      n += d
      yield n                          // this is the output
    }
  }, undefined, { initial: 0 })

  return mount(host, div({ class: 'row' },
    button({ onclick: () => counter.cast(-1) }, '−'),
    span({ class: 'count' }, counter),   // a live binding — the view runs once
    button({ onclick: () => counter.cast(1) }, '+')))
}
