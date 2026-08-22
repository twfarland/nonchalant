// Drag — an interaction with a lifetime. pointerdown spawns a gesture
// process; it yields offsets; pointerup disposes it. The gesture's whole
// footprint — its subscription included — ends when it does. No listener
// bookkeeping survives the gesture, because nothing about it is global.

import { cell, effect, spawn } from '@nonchalant/core'
import type { Self, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { div, p } from '@nonchalant/dom/tags'

type Offset = { dx: number; dy: number }

const pos = cell({ x: 60, y: 40 })
const dragging = cell(false)

const startDrag = (down: PointerEvent): void => {
  const base = pos() // where the box was when the gesture began
  const gesture = spawn(async function* (self: Self<PointerEvent>): AsyncGenerator<Offset> {
    for await (const move of self)
      yield { dx: move.clientX - down.clientX, dy: move.clientY - down.clientY }
  }, undefined)

  const stop = effect(() => {
    const o = gesture()
    if (o) pos.send({ x: base.x + o.dx, y: base.y + o.dy })
  })

  const onMove = (e: PointerEvent): void => gesture.send(e)
  const onUp = (): void => {
    removeEventListener('pointermove', onMove)
    removeEventListener('pointerup', onUp)
    stop()
    gesture[Symbol.dispose]() // the gesture is over; everything it owned is gone
    dragging.send(false)
  }
  addEventListener('pointermove', onMove)
  addEventListener('pointerup', onUp)
  dragging.send(true)
}

function App(): VNode {
  return div({ class: 'card' },
    p({ class: 'muted' }, 'Drag the box. Each drag is a process: born on pointerdown, dead on pointerup.'),
    div({ class: 'drag-stage' },
      div({
        class: () => `drag-box${dragging() ? ' dragging' : ''}`,
        style: () => `transform: translate(${pos().x}px, ${pos().y}px)`,
        onpointerdown: startDrag,
      }, () => (dragging() ? 'wheee' : 'drag me'))))
}

mount(document.getElementById('app')!, App())
