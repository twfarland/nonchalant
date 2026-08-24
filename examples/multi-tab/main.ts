// Multi-tab sync over a BroadcastChannel transport — no server anywhere.
// Leader election is automatic via the Web Locks API: every tab asks for the
// same lock; the browser grants it to one. That tab hosts the counter and
// announces itself; every tab (including the host's own) talks to it as a
// client. Close the hosting tab and the lock passes to another, which starts
// hosting fresh state and announces — the other tabs re-look-up and carry on.

import { cell, define, registry } from '@nonchalant/core'
import type { Cast, Definition, Proc, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, h2, span } from '@nonchalant/dom/tags'
import { broadcastChannelTransport, connect, expose } from '@nonchalant/wire'

type CounterMsg = Cast<{ type: 'add'; n: number }>
type CounterState = { n: number }

const counter: Proc<CounterState, CounterMsg, void> = async function* (self) {
  let n = 0
  yield { n }
  for await (const msg of self) {
    n += msg.n
    yield { n }
  }
}

type Schema = { counter: Definition<CounterState, CounterMsg, void> }
const CHANNEL = 'nonchalant-multi-tab'

const hosting = cell(false)

// whichever tab wins this lock hosts; it keeps the lock until the tab dies
void navigator.locks.request(CHANNEL, async () => {
  const hostTransport = broadcastChannelTransport(CHANNEL)
  expose(registry({ counter: define(counter) }), hostTransport)
  hostTransport.announce() // tell every tab (this one included) to look up
  hosting.cast(true)
  await new Promise(() => {}) // hold the lock for this tab's lifetime
})

// every tab is a client — the host's own tab too, so the code is uniform
const shared = connect<Schema>(broadcastChannelTransport(CHANNEL)).lookup('counter')

function App(): VNode {
  return div({ class: 'card' },
    h2({}, () => (hosting() ? 'This tab is hosting' : 'This tab is following')),
    button({ onclick: () => shared.cast({ type: 'add', n: 1 }) }, '+1 from this tab'),
    span({ class: 'value' }, () => String(shared()?.n ?? '…')),
    span({ class: 'muted', hidden: () => !shared.stale }, ' reconnecting…'),
    div({ class: 'muted' }, 'Open this page in more tabs. Close the hosting one and watch the lock move.'))
}

mount(document.getElementById('app')!, App())
