// 7GUIs 6/7 — Circle drawer: undo/redo over snapshots, SVG through h()
// (namespace inference), keyed circles, a slider adjusting the selected
// radius. Radius drags collapse into one undo step on release.

import { cell, spawn } from '@nonchalant/core'
import type { Cast, Proc } from '@nonchalant/core'
import { h, mount } from '@nonchalant/dom'
import { button, div, input, label } from '@nonchalant/dom/tags'

type Circle = { id: number; x: number; y: number; r: number }
type DrawMsg =
  | Cast<{ type: 'add'; x: number; y: number }>
  | Cast<{ type: 'resize'; id: number; r: number }> // transient: not an undo step
  | Cast<{ type: 'commit' }> // end of a radius drag: snapshot now
  | Cast<{ type: 'undo' }>
  | Cast<{ type: 'redo' }>

const drawing: Proc<Circle[], DrawMsg, void> = async function* (self) {
  let circles: Circle[] = []
  let nextId = 1
  const past: Circle[][] = []
  const future: Circle[][] = []
  let dragBase: Circle[] | null = null // state before the current radius drag
  const snapshot = (state: Circle[]): void => {
    past.push(state)
    future.length = 0
  }
  yield circles
  for await (const msg of self) {
    if (msg.type === 'add') {
      snapshot(circles)
      circles = [...circles, { id: nextId++, x: msg.x, y: msg.y, r: 20 }]
    } else if (msg.type === 'resize') {
      if (dragBase === null) dragBase = circles
      circles = circles.map((c) => (c.id === msg.id ? { ...c, r: msg.r } : c))
    } else if (msg.type === 'commit') {
      // the whole drag is one undo step: snapshot what it started from
      if (dragBase !== null && dragBase !== circles) snapshot(dragBase)
      dragBase = null
      continue
    } else if (msg.type === 'undo') {
      if (past.length === 0) continue
      future.push(circles)
      circles = past.pop() as Circle[]
    } else {
      if (future.length === 0) continue
      past.push(circles)
      circles = future.pop() as Circle[]
    }
    yield circles
  }
}

const store = spawn(drawing, undefined, { initial: [] as Circle[] })
const selected = cell(0)

mount(document.getElementById('app')!, div({},
  div({},
    button({ onclick: () => store.cast({ type: 'undo' }) }, 'Undo'),
    button({ onclick: () => store.cast({ type: 'redo' }) }, 'Redo')),
  h('svg', {
    width: 500, height: 300, style: 'border: 1px solid #666',
    onclick: (e: MouseEvent) => {
      const box = (e.currentTarget as SVGElement).getBoundingClientRect()
      store.cast({ type: 'add', x: e.clientX - box.left, y: e.clientY - box.top })
    },
  }, () => store().map((c) =>
    h('circle', {
      key: c.id, cx: c.x, cy: c.y, r: c.r,
      fill: () => (selected() === c.id ? '#ddd' : 'transparent'),
      stroke: 'black',
      onclick: (e: Event) => {
        e.stopPropagation()
        selected.cast(c.id)
      },
    }))),
  div({ hidden: () => selected() === 0 },
    label({}, () => `Radius of circle ${selected()}: `),
    input({
      type: 'range', min: 2, max: 100,
      value: () => String(store().find((c) => c.id === selected())?.r ?? 20),
      oninput: (e: Event) =>
        store.cast({ type: 'resize', id: selected(), r: Number((e.target as HTMLInputElement).value) }),
      onchange: () => store.cast({ type: 'commit' }),
    }))))
