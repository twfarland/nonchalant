// Router — a state process whose values are pages. The URL is a process;
// navigation is iteration; a loading state is an interim yield; code
// splitting is just `await import()`; and disposing the outgoing page tears
// down its whole scope (its state, its spawns, its subscriptions).

import { spawn } from '@nonchalant/core'
import type { Proc, Process, Self, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { a, div, h2, nav, p, span } from '@nonchalant/dom/tags'

type Route = 'home' | 'about'
const parse = (): Route => (location.hash === '#/about' ? 'about' : 'home')

const HomeView: Proc<VNode, never, void> = async function* (self) {
  yield div({}, h2({}, 'Home'), p({}, 'Eagerly loaded.'))
  for await (const _ of self) void _ // stay alive until the router disposes us
}

const Spinner = (): VNode => p({ class: 'muted' }, 'loading…')

// the URL as a process: hashchange events feed it
const route = spawn<Route, Route, void>(async function* (self: Self<Route>) {
  const onChange = (): void => self.send(parse())
  addEventListener('hashchange', onChange)
  self.signal.addEventListener('abort', () => removeEventListener('hashchange', onChange))
  yield parse()
  for await (const r of self.latest()) yield r
}, undefined, { initial: parse() })

// the router: swaps whole pages, so it re-yields per navigation (structural
// change is exactly what re-yielding is for)
const RouterView: Proc<VNode, never, void> = async function* () {
  const shell = (page: VNode | Process<VNode | undefined>): VNode =>
    div({ class: 'card' },
      nav({}, a({ href: '#/' }, 'Home'), ' · ', a({ href: '#/about' }, 'About'),
        span({ class: 'muted' }, ' (About is a separate chunk)')),
      div({ class: 'page' }, page))

  let current: Process<VNode | undefined> | null = null
  for await (const r of route) {
    current?.[Symbol.dispose]() // the outgoing page's entire scope ends here
    if (r === 'about') {
      yield shell(Spinner()) // interim yield: the loading state
      const { AboutView } = await import('./about.ts') // the code-split point
      current = spawn(AboutView, undefined)
    } else {
      current = spawn(HomeView, undefined)
    }
    yield shell(current) // a view process is a valid slot
  }
}

mount(document.getElementById('app')!, spawn(RouterView, undefined))
