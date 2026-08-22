// Chat — a client-server room over the wire protocol. Start the server with
// `pnpm chat-server`, then open this page in several tabs (or several
// browsers): every tab looks up the same room by name and reads the same
// process. Posts are casts; history arrives as patches; killing the server
// shows stale reads until the reconnecting transport finds it again.

import { cell, effect } from '@nonchalant/core'
import type { Process, VNode } from '@nonchalant/core'
import { connect, webSocketTransport } from '@nonchalant/wire'
import { mount } from '@nonchalant/dom'
import { button, div, form, input, li, p, span, ul } from '@nonchalant/dom/tags'
import type { ChatSchema, RoomMsg, RoomState } from './shared.ts'

const conn = connect<ChatSchema>(webSocketTransport('ws://127.0.0.1:4322/'))
const lobby = conn.lookup('room', { name: 'lobby' }) as Process<RoomState | undefined, RoomMsg>

const me = cell(`guest-${Math.floor(Math.random() * 1000)}`)

function Chat(): VNode {
  return div({ class: 'card' },
    p({ class: 'muted' },
      'Needs the server: run ', span({ class: 'value' }, 'pnpm chat-server'),
      ' — then open this page in more tabs.'),
    ul({ class: 'chat-log', id: 'log' }, () =>
      (lobby()?.lines ?? []).map((l) =>
        li({ key: l.id }, span({ class: 'from' }, l.from), l.text))),
    form({
      class: 'chat-form',
      onsubmit: (e: Event) => {
        e.preventDefault()
        const el = (e.target as HTMLFormElement).elements.namedItem('text') as HTMLInputElement
        lobby.send({ type: 'post', from: me(), text: el.value })
        el.value = ''
      },
    },
      input({
        name: 'name', size: 10, value: me,
        oninput: (e: Event) => me.send((e.target as HTMLInputElement).value),
      }),
      input({ name: 'text', placeholder: 'say something…', autocomplete: 'off' }),
      button({ type: 'submit', disabled: () => lobby.stale || lobby() === undefined }, 'Send')),
    p({ class: 'muted', hidden: () => !lobby.stale }, 'server unreachable — reconnecting…'))
}

mount(document.getElementById('app')!, Chat())

// keep the log pinned to the newest message (runs after the list binding:
// effects wake in subscription order, and this one subscribed last)
effect(() => {
  void lobby()
  const log = document.getElementById('log')
  if (log) log.scrollTop = log.scrollHeight
})
