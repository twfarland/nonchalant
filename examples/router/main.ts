// Router — built on the userland router in ../lib/router.ts, to show how
// little a "construct" costs here. Pages are view processes: navigating
// disposes the outgoing page (its whole scope), yields a loading state,
// `await import()`s the chunk, and yields the new page. Links replace
// history by default, so back-button behavior stays sane.

import { spawn } from '@nonchalant/core'
import type { Proc, Process, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { a, div, h2, nav, p, span } from '@nonchalant/dom/tags'
import { hashRouter } from '../lib/router.ts'

type Route = 'home' | 'about'

const router = hashRouter<Route>((path) => (path === '/about' ? 'about' : 'home'))

// ---------- pages ----------

const HomeView: Proc<VNode, never, void> = async function* (self) {
  yield div({},
    h2({}, 'Home'),
    p({}, 'Eagerly loaded.'))

  for await (const _ of self) void _ // stay alive until the router disposes us
}

const Spinner = (): VNode => p({ class: 'muted' }, 'loading…')

// ---------- chrome ----------

const Nav = (): VNode =>
  nav({},
    a({ ...router.link('/') }, 'Home'),
    ' · ',
    a({ ...router.link('/about') }, 'About'),
    span({ class: 'muted' }, ' (About is a separate chunk)'))

const Shell = (page: VNode | Process<VNode | undefined>): VNode =>
  div({ class: 'card' },
    Nav(),
    div({ class: 'page' }, page))

// ---------- the router view ----------

const RouterView: Proc<VNode, never, void> = async function* () {
  let current: Process<VNode | undefined> | null = null

  for await (const route of router.route) {
    current?.[Symbol.dispose]() // the outgoing page's entire scope ends here

    if (route === 'about') {
      yield Shell(Spinner()) // interim yield: the loading state
      const { AboutView } = await import('./about.ts') // the code-split point
      current = spawn(AboutView, undefined)
    } else {
      current = spawn(HomeView, undefined)
    }

    yield Shell(current) // a view process is a valid slot
  }
}

mount(document.getElementById('app')!, spawn(RouterView, undefined))
