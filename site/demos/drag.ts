// A gesture with a lifetime. The process is born on pointerdown, yields an
// offset per move, and is disposed on pointerup — its whole footprint, the
// effect included, ends when it does. There is nothing to unsubscribe.

import { cell, effect, spawn } from '@nonchalant/core'
import type { Self } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { div } from '@nonchalant/dom/tags'

type Offset = { x: number; y: number }

const clamp = (v: number, max: number): number => Math.max(0, Math.min(max, v))

export function run(host: Element): Disposable {
  const at = cell<Offset>({ x: 0, y: 0 })
  let base: Offset = { x: 0, y: 0 }

  const onpointerdown = (down: PointerEvent): void => {
    const box = down.currentTarget as HTMLElement
    const field = box.parentElement
    if (field === null) return
    const maxX = field.clientWidth - box.offsetWidth
    const maxY = field.clientHeight - box.offsetHeight

    // spawn before awaiting: ownership is ambient only in this synchronous window
    const gesture = spawn(async function* (self: Self<PointerEvent>) {
      for await (const move of self)
        yield {
          x: clamp(base.x + move.clientX - down.clientX, maxX),
          y: clamp(base.y + move.clientY - down.clientY, maxY),
        }
    }, undefined)

    const stop = effect(() => {
      const o = gesture()
      if (o !== undefined) at.send(o)
    })
    const onmove = (e: PointerEvent): void => gesture.send(e)
    const onup = (): void => {
      removeEventListener('pointermove', onmove)
      removeEventListener('pointerup', onup)
      base = at()
      stop()
      gesture[Symbol.dispose]()
    }
    addEventListener('pointermove', onmove)
    addEventListener('pointerup', onup)
  }

  return mount(host, div({ class: 'dragfield' },
    div({
      class: 'dragbox',
      style: () => `position:absolute; left:0; top:0; transform: translate(${at().x}px, ${at().y}px)`,
      onpointerdown,
    }, 'drag me')))
}
