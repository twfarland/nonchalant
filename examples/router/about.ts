// The lazily-loaded page — this module is a code-split point: it only
// downloads the first time someone navigates to /about. The page is a view
// process, so it can hold its own state and everything it spawns dies with
// it when the router disposes it.

import { cell } from '@nonchalant/core'
import type { Proc, Self, VNode } from '@nonchalant/core'
import { button, div, h2, p, span } from '@nonchalant/dom/tags'

export const AboutView: Proc<VNode, never, void> = async function* (self: Self<never>) {
  const visits = cell(0) // page-local state, owned by this page, gone with it
  yield div({},
    h2({}, 'About'),
    p({}, 'This page arrived over a dynamic import, and it has its own state:'),
    button({ onclick: () => visits.send(visits() + 1) }, 'clicked '),
    span({ class: 'value' }, visits))
  // a page that owns state must stay alive: returning would end this process
  // and dispose everything it spawned (the cell above included). The router
  // disposing us closes the mailbox, which ends this wait cleanly.
  for await (const _ of self) void _
}
