// Route pages. In a real app each page lives in its own module so the
// dynamic import in main.ts is a code-split point; About stands in for
// the lazily-loaded one.

import type { VNode } from '@nonchalant/core'
import { div, h2, p } from '@nonchalant/dom/tags'

export function Home(): VNode {
  return div({}, h2({}, 'Home'), p({}, 'Eagerly loaded.'))
}

export function About(): VNode {
  return div({}, h2({}, 'About'), p({}, 'This page arrived over a dynamic import.'))
}
