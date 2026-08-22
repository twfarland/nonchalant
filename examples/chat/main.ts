// Chat — client-server rooms over the wire protocol. Start the server with
// `pnpm chat-server`, open this page in several tabs, and hop between rooms.
//
// Every room is one process on the server, spawned the first time anyone
// looks its name up and evicted after an hour idle. A room is ~kilobytes of
// suspended generator, so one node process holds thousands of them — the
// registry, not your code, is the room lifecycle. Kill the server mid-chat
// to watch stale reads and the reconnect.

import { cell, effect } from '@nonchalant/core'
import type { Process, VNode } from '@nonchalant/core'
import { connect, webSocketTransport } from '@nonchalant/wire'
import { mount } from '@nonchalant/dom'
import { button, div, form, input, li, p, span, ul } from '@nonchalant/dom/tags'
import type { ChatSchema, RoomMsg, RoomState } from './shared.ts'

type Room = Process<RoomState | undefined, RoomMsg>

const conn = connect<ChatSchema>(webSocketTransport('ws://127.0.0.1:4322/'))

const me = cell(`guest-${Math.floor(Math.random() * 1000)}`)
const roomName = cell('lobby')

// get-or-spawn on both sides: the same name is the same room everywhere
const room = (): Room => conn.lookup('room', { name: roomName() }) as Room

// ---------- components ----------

function RoomPicker(): VNode {
  const join = (name: string): void => roomName.send(name)

  return div({ class: 'rooms' },
    ...['lobby', 'dev', 'random'].map((name) =>
      button({
        class: () => (roomName() === name ? 'selected' : ''),
        onclick: () => join(name),
      }, `#${name}`)),

    input({
      placeholder: 'or make one up…',
      onkeydown: (e: KeyboardEvent) => {
        const value = (e.target as HTMLInputElement).value.trim()
        if (e.key === 'Enter' && value !== '') join(value.toLowerCase())
      },
    }))
}

function ChatLog(): VNode {
  return ul({ class: 'chat-log', id: 'log' }, () => {
    const r = room()
    return (r()?.lines ?? []).map((l) =>
      li({ key: l.id }, span({ class: 'from' }, l.from), l.text))
  })
}

function Composer(): VNode {
  const post = (e: Event): void => {
    e.preventDefault()
    const el = (e.target as HTMLFormElement).elements.namedItem('text') as HTMLInputElement
    room().send({ type: 'post', from: me(), text: el.value })
    el.value = ''
  }

  return form({ class: 'chat-form', onsubmit: post },
    input({
      name: 'name', size: 10, value: me,
      oninput: (e: Event) => me.send((e.target as HTMLInputElement).value),
    }),
    input({ name: 'text', placeholder: () => `say something in #${roomName()}…`, autocomplete: 'off' }),
    button({ type: 'submit', disabled: () => room().stale || room()() === undefined }, 'Send'))
}

// ---------- the page ----------

function Chat(): VNode {
  return div({ class: 'card' },
    p({ class: 'muted' },
      'Needs the server: run ', span({ class: 'value' }, 'pnpm chat-server'),
      ' — then open this page in more tabs.'),

    RoomPicker(),
    ChatLog(),
    Composer(),

    p({ class: 'muted', hidden: () => !room().stale }, 'server unreachable — reconnecting…'))
}

mount(document.getElementById('app')!, Chat())

// keep the log pinned to the newest message (runs after the list binding:
// effects wake in subscription order, and this one subscribed last)
effect(() => {
  const r = room()
  void r()
  const log = document.getElementById('log')
  if (log) log.scrollTop = log.scrollHeight
})
