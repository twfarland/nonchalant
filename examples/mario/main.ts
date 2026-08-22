// Browser bootstrap: rAF drives ticks, the keyboard drives arrow state.
// Key-repeat re-sends the same arrows — which steps nothing (see mario.ts).

import { cell, spawn } from '@nonchalant/core'
import type { Self, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { MarioView, initialMario, mario, type Dims } from './mario.ts'

const world = spawn(mario, undefined, { initial: initialMario })

const stage = document.getElementById('stage')!
const size = (): Dims => ({ w: stage.clientWidth, h: stage.clientHeight })
const dims = cell<Dims>(size())
addEventListener('resize', () => dims.send(size()))

const keys = new Set<string>()
const sendArrows = (): void =>
  world.send({
    type: 'arrows',
    x: (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0),
    y: (keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0),
  })
addEventListener('keydown', (e) => {
  keys.add(e.key)
  sendArrows()
})
addEventListener('keyup', (e) => {
  keys.delete(e.key)
  sendArrows()
})

let last = performance.now()
const frame = (t: number): void => {
  world.send({ type: 'tick', delta: (t - last) / 20 })
  last = t
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

const view = spawn(async function* (_self: Self<never>): AsyncGenerator<VNode> {
  yield MarioView(world, dims)
}, undefined)

mount(stage, view)
