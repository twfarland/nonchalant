// Mario, from the classic Elm example (https://elm-lang.org/examples/mario).
// The physics is verbatim; the input handling is what this port is about —
// arrows are state inside the process and only ticks step the world, so key
// repeat cannot double-step it (in signal libraries that merge input and frame
// streams, it does). The view yields ONCE: two attribute bindings carry every
// frame, which CI pins at ≤ 3 DOM writes per frame and zero node churn.

import { cell, spawn } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { div } from '@nonchalant/dom/tags'
import { MarioView, initialMario, mario, type Dims } from '../../examples/mario/mario.ts'

const SPRITES = 'examples/mario/img/mario' // shipped with the gallery, reached from this page
const HEIGHT = 200

export function run(host: Element): Disposable {
  const world = spawn(mario, undefined, { initial: initialMario })
  const dims = cell<Dims>({ w: host.clientWidth, h: HEIGHT })

  const held = new Set<string>()
  const arrows = (): void =>
    world.cast({
      type: 'arrows',
      x: (held.has('ArrowRight') ? 1 : 0) - (held.has('ArrowLeft') ? 1 : 0),
      y: (held.has('ArrowUp') ? 1 : 0) - (held.has('ArrowDown') ? 1 : 0),
    })

  // the keys are the stage's, not the page's: arrows still scroll everywhere else
  const onkeydown = (e: KeyboardEvent): void => {
    if (!e.key.startsWith('Arrow')) return
    e.preventDefault()
    held.add(e.key)
    arrows()
  }
  const onkeyup = (e: KeyboardEvent): void => {
    held.delete(e.key)
    arrows()
  }

  let frame = 0
  let last = performance.now()
  const tick = (t: number): void => {
    world.cast({ type: 'tick', delta: (t - last) / 20 }) // ms / 20, as the original's signal did
    last = t
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)

  const onresize = (): void => dims.cast({ w: host.clientWidth, h: HEIGHT })
  addEventListener('resize', onresize)

  const view = mount(host, div({ class: 'mariostage', tabindex: '0', onkeydown, onkeyup },
    MarioView(world, dims, SPRITES)))

  return {
    [Symbol.dispose]: () => {
      cancelAnimationFrame(frame)
      removeEventListener('resize', onresize)
      view[Symbol.dispose]()
      world[Symbol.dispose]()
    },
  }
}
