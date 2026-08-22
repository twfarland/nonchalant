// Counter — the smallest possible example. `cell` holds transient state as a
// closed-over process, and a Process is already a valid slot, so
// `span({}, count)` is a live binding.

import { cell } from '@nonchalant/core'
import type { VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, span } from '@nonchalant/dom/tags'

function Counter(): VNode {
  const count = cell(0)
  return div(
    { class: 'card' },
    button({ onclick: () => count.send(count() - 1) }, '−'),
    span({ class: 'value' }, count),
    button({ onclick: () => count.send(count() + 1) }, '+'),
  )
}

mount(document.getElementById('app')!, Counter())
