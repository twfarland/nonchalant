// The live graph is a view of one value: the root run's state is the whole call
// tree, so drawing it is a recursive function of a Node, bound once. Keys are
// the node ids, so a token arriving three levels down patches one text node.

import '../inspector/enable.ts'
import { cell, derive, spawn } from '@nonchalant/core'
import type { Process, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, input, li, span, ul } from '@nonchalant/dom/tags'
import { crew, queued, stubModel, text, type Node, type Run } from './delegation.ts'

// ---------- state ----------

const lead = crew(stubModel({ latency: 500 }), { searchLatency: 700 })

// a top-level run has no owner to die with, so this cell is its owner
const current = cell<Process<Node> | null>(null)
const tree = derive(() => current()?.() ?? null)

function ask(question: string): void {
  current()?.[Symbol.dispose]()
  const run: Run = { id: 'root', name: 'lead', input: question }
  current.cast(spawn(lead.run, run, { initial: queued(lead, run) }))
}

// ---------- components ----------

function Ask(): VNode {
  const question = cell('process vs actor and signal, 6 * 7')
  return div({ class: 'row' },
    input({
      type: 'text', size: 40, value: question,
      oninput: (e) => question.cast(e.currentTarget.value),
      onkeydown: (e) => { if (e.key === 'Enter') ask(question()) },
    }),
    button({ onclick: () => ask(question()) }, 'ask'),
    button({ onclick: () => current()?.[Symbol.dispose]() }, 'stop'))
}

function NodeView(n: Node): VNode {
  return li({ key: n.id, class: `node ${n.kind} ${n.status}` },
    div({ class: 'head' },
      span({ class: 'kind' }, n.kind),
      span({ class: 'name' }, `${n.name}(${n.input})`),
      span({ class: 'status' }, n.status)),
    n.output.length === 0 ? null : div({ class: 'out' }, text(n)),
    n.children.length === 0 ? null : ul({ class: 'tree' }, n.children.map(NodeView)))
}

function Graph(): VNode {
  return ul({ class: 'tree root' }, () => {
    const t = tree()
    return t === null ? span({ class: 'muted' }, 'ask something') : NodeView(t)
  })
}

// ---------- the app ----------

function App(): VNode {
  return div({ class: 'card' }, Ask(), Graph())
}

mount(document.getElementById('app')!, App())
