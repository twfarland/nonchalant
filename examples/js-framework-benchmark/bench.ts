// The standard js-framework-benchmark app (krausest), nonchalant edition:
// one state process, one keyed thunk hole. Submission to the harness repo is
// an external step; this module is the implementation, compiled in CI and
// held to count budgets by bench.test.ts.
//
// Selection is its own process yielding `{ [id]: true }`. Each row reads
// `selection()[row.id]` — a path read — so a change wakes exactly the rows
// whose entry appeared or vanished: the old selection and the new. (Comparing
// `selected() === row.id` would read the whole value and wake every row.)

import type { Cast, Proc, Process, VNode } from '@nonchalant/core'
import { a, button, div, h1, span, table, tbody, td, tr } from '@nonchalant/dom/tags'

export type Row = { id: number; label: string }

export type Msg =
  | Cast<{ type: 'run'; n: number }>
  | Cast<{ type: 'append'; n: number }>
  | Cast<{ type: 'update-every-10th' }>
  | Cast<{ type: 'clear' }>
  | Cast<{ type: 'swap' }>
  | Cast<{ type: 'remove'; id: number }>

export type Selection = { readonly [id: number]: true }

export type SelectMsg = Cast<{ type: 'select'; id: number }>

const adjectives = ['pretty', 'large', 'big', 'small', 'tall', 'short', 'long', 'handsome', 'plain', 'quaint', 'clean', 'elegant', 'easy', 'angry', 'crazy', 'helpful', 'mushy', 'odd', 'unsightly', 'adorable', 'important', 'inexpensive', 'cheap', 'expensive', 'fancy']
const colours = ['red', 'yellow', 'blue', 'green', 'pink', 'brown', 'purple', 'brown', 'white', 'black', 'orange']
const nouns = ['table', 'chair', 'house', 'bbq', 'desk', 'car', 'pony', 'cookie', 'sandwich', 'burger', 'pizza', 'mouse', 'keyboard']
const pick = (xs: string[]): string => xs[Math.floor(Math.random() * xs.length)] as string

// ---------- state ----------

export const rows: Proc<Row[], Msg, void> = async function* (self) {
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

export const selection: Proc<Selection, SelectMsg, void> = async function* (self) {
  let sel: Selection = {}
  yield sel
  for await (const msg of self) {
    switch (msg.type) {
      case 'select':
        sel = { [msg.id]: true }
        break
    }
    yield sel
  }
}

// ---------- the app ----------

export function App(store: Process<Row[], Msg>, selected: Process<Selection, SelectMsg>): VNode {
  const action = (id: string, label: string, msg: Msg): VNode =>
    div({ class: 'col-sm-6 smallpad' },
      button({ type: 'button', class: 'btn btn-primary btn-block', id, onclick: () => store.cast(msg) }, label))
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
          tr({ key: row.id, class: () => (selected()[row.id] === true ? 'danger' : '') },
            td({ class: 'col-md-1' }, String(row.id)),
            td({ class: 'col-md-4' },
              a({ class: 'lbl', onclick: () => selected.cast({ type: 'select', id: row.id }) }, row.label)),
            td({ class: 'col-md-1' },
              a({ class: 'remove', onclick: () => store.cast({ type: 'remove', id: row.id }) },
                span({ class: 'glyphicon glyphicon-remove', 'aria-hidden': 'true' }))),
            td({ class: 'col-md-6' }))))),
    span({ class: 'preloadicon glyphicon glyphicon-remove', 'aria-hidden': 'true' }))
}

