// Counter — transient state as a closed-over process (docs/DESIGN.md §07).
// `cell` is an anonymous spawn owned by the enclosing scope; a Process is
// already a valid slot, so `span({}, count)` is a live binding.

import { cell } from '@nonchalant/core'
import type { VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, span } from '@nonchalant/dom/tags'

function Counter(): VNode {
  const count = cell(0)
  return div(
    { class: 'counter' },
    button({ onclick: () => count.send(count() - 1) }, '−'),
    span({}, count),
    button({ onclick: () => count.send(count() + 1) }, '+'),
  )
}

mount(document.getElementById('app')!, Counter())
