// Multi-tab sync — a BroadcastChannel transport against the same 8-op
// protocol. One tab hosts, the rest connect; the wire never assumed a server,
// only a transport. Leader election is deliberately naive here (open the
// hosting tab with #host); a real app would elect via Web Locks.

import { define, registry, spawn } from '@nonchalant/core'
import type { Definition, Proc, Process, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, h2, span } from '@nonchalant/dom/tags'
import { broadcastChannelTransport, connect, expose } from '@nonchalant/wire'

type CounterMsg = { type: 'add'; n: number }
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

const transport = broadcastChannelTransport('nonchalant-multi-tab')
const hosting = location.hash === '#host'

let shared: Process<CounterState | undefined, CounterMsg>
if (hosting) {
  const reg = registry({ counter: define(counter) })
  expose(reg, transport)
  shared = reg.lookup('counter') as Process<CounterState | undefined, CounterMsg>
} else {
  shared = connect<Schema>(transport).lookup('counter') as Process<CounterState | undefined, CounterMsg>
}

function App(): VNode {
  return div({},
    h2({}, hosting ? 'This tab hosts' : 'This tab follows'),
    button({ onclick: () => shared.send({ type: 'add', n: 1 }) }, '+1 (any tab)'),
    span({ class: 'value' }, () => String(shared()?.n ?? '…')),
    span({ class: 'stale', hidden: () => !shared.stale }, ' (stale — host gone?)'))
}

mount(document.getElementById('app')!, App())
