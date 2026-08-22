// The standard js-framework-benchmark app (krausest), nonchalant edition:
// one state process, one keyed thunk hole. Submission to the harness repo is
// an external step; this module is the implementation, compiled in CI.
// Selection is a separate process so selecting a row wakes exactly two rows
// (the old and the new), not the table.

import { cell, spawn } from '@nonchalant/core'
import type { Proc, Process, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { a, button, div, h1, span, table, tbody, td, tr } from '@nonchalant/dom/tags'

type Row = { id: number; label: string }

type Msg =
  | { type: 'run'; n: number }
  | { type: 'append'; n: number }
  | { type: 'update-every-10th' }
  | { type: 'clear' }
  | { type: 'swap' }
  | { type: 'remove'; id: number }

const adjectives = ['pretty', 'large', 'big', 'small', 'tall', 'short', 'long', 'handsome', 'plain', 'quaint', 'clean', 'elegant', 'easy', 'angry', 'crazy', 'helpful', 'mushy', 'odd', 'unsightly', 'adorable', 'important', 'inexpensive', 'cheap', 'expensive', 'fancy']
const colours = ['red', 'yellow', 'blue', 'green', 'pink', 'brown', 'purple', 'brown', 'white', 'black', 'orange']
const nouns = ['table', 'chair', 'house', 'bbq', 'desk', 'car', 'pony', 'cookie', 'sandwich', 'burger', 'pizza', 'mouse', 'keyboard']
const pick = (xs: string[]): string => xs[Math.floor(Math.random() * xs.length)] as string

const rows: Proc<Row[], Msg, void> = async function* (self) {
  let data: Row[] = []
  let nextId = 1
  const fresh = (n: number): Row[] =>
    Array.from({ length: n }, () => ({ id: nextId++, label: `${pick(adjectives)} ${pick(colours)} ${pick(nouns)}` }))
  yield data
  for await (const msg of self) {
    switch (msg.type) {
      case 'run':
        data = fresh(msg.n)
        break
      case 'append':
        data = [...data, ...fresh(msg.n)]
        break
      case 'update-every-10th':
        data = data.map((r, i) => (i % 10 === 0 ? { ...r, label: `${r.label} !!!` } : r))
        break
      case 'clear':
        data = []
        break
      case 'swap':
        if (data.length > 998) {
          data = [...data]
          const t = data[1] as Row
          data[1] = data[998] as Row
          data[998] = t
        }
        break
      case 'remove':
        data = data.filter((r) => r.id !== msg.id)
        break
    }
    yield data
  }
}

function App(store: Process<Row[], Msg>, selected: Process<number, number>): VNode {
  const action = (id: string, label: string, msg: Msg): VNode =>
    div({ class: 'col-sm-6 smallpad' },
      button({ type: 'button', class: 'btn btn-primary btn-block', id, onclick: () => store.send(msg) }, label))
  return div({ class: 'container' },
    div({ class: 'jumbotron' },
      div({ class: 'row' },
        div({ class: 'col-md-6' }, h1({}, 'nonchalant')),
        div({ class: 'col-md-6' },
          div({ class: 'row' },
            action('run', 'Create 1,000 rows', { type: 'run', n: 1000 }),
            action('runlots', 'Create 10,000 rows', { type: 'run', n: 10_000 }),
            action('add', 'Append 1,000 rows', { type: 'append', n: 1000 }),
            action('update', 'Update every 10th row', { type: 'update-every-10th' }),
            action('clear', 'Clear', { type: 'clear' }),
            action('swaprows', 'Swap Rows', { type: 'swap' }))))),
    table({ class: 'table table-hover table-striped test-data' },
      tbody({ id: 'tbody' }, () =>
        store().map((row) =>
          tr({ key: row.id, class: () => (selected() === row.id ? 'danger' : '') },
            td({ class: 'col-md-1' }, String(row.id)),
            td({ class: 'col-md-4' },
              a({ class: 'lbl', onclick: () => selected.send(row.id) }, row.label)),
            td({ class: 'col-md-1' },
              a({ class: 'remove', onclick: () => store.send({ type: 'remove', id: row.id }) },
                span({ class: 'glyphicon glyphicon-remove', 'aria-hidden': 'true' }))),
            td({ class: 'col-md-6' }))))),
    span({ class: 'preloadicon glyphicon glyphicon-remove', 'aria-hidden': 'true' }))
}

const store = spawn(rows, undefined, { initial: [] as Row[] })
const selected = cell(0)
mount(document.getElementById('main')!, App(store, selected))
