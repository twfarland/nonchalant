// Router — a route is just a process of the current path; a lazy route is a
// thunk that resolves through import() (the sink keeps the previous page
// until the chunk lands, and a newer navigation supersedes a stale load).

import { spawn } from '@nonchalant/core'
import type { Proc, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { a, div, nav } from '@nonchalant/dom/tags'
import { Home } from './pages.ts'

type Route = 'home' | 'about'

const parse = (): Route => (location.hash === '#/about' ? 'about' : 'home')

const router: Proc<Route, Route, void> = async function* (self) {
  const onChange = (): void => self.send(parse())
  addEventListener('hashchange', onChange)
  self.signal.addEventListener('abort', () => removeEventListener('hashchange', onChange))
  yield parse()
  for await (const route of self.latest()) yield route
}

function App(): VNode {
  const route = spawn(router, undefined, { initial: parse() })
  return div({ class: 'card' },
    nav({},
      a({ href: '#/' }, 'Home'),
      ' · ',
      a({ href: '#/about' }, 'About')),
    // the code-split point: About's module loads on first navigation
    div({ class: 'page' }, () =>
      route() === 'about' ? import('./pages.ts').then((m) => m.About()) : Home()))
}

mount(document.getElementById('app')!, App())
