// The same Mario, retargeted: identical state process, identical physics,
// identical input wiring — the renderer is a canvas effect instead of the DOM
// sink. Retargeting demonstrated, not asserted (ROADMAP M8): a canvas "sink"
// for this scene is one tracked effect that redraws when the state it read
// changes.

import { cell, effect, spawn } from '@nonchalant/core'
import { initialMario, mario, sprite, type Dims } from '../mario/mario.ts'

const world = spawn(mario, undefined, { initial: initialMario })
const dims = cell<Dims>({ w: innerWidth, h: innerHeight })
addEventListener('resize', () => dims.send({ w: innerWidth, h: innerHeight }))

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

const canvas = document.createElement('canvas')
document.body.appendChild(canvas)
const ctx = canvas.getContext('2d')!

const images = new Map<string, HTMLImageElement>()
const imageFor = (src: string): HTMLImageElement => {
  let im = images.get(src)
  if (im === undefined) {
    im = new Image()
    im.src = src
    images.set(src, im)
  }
  return im
}

effect(() => {
  const m = world()
  const { w, h } = dims()
  canvas.width = w
  canvas.height = h
  ctx.fillStyle = 'rgb(174,238,238)'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = 'rgb(74,167,43)'
  ctx.fillRect(0, h - 50, w, 50)
  const im = imageFor(sprite(m))
  ctx.drawImage(im, m.x, h - 50 - 35 - m.y)
})

let last = performance.now()
const frame = (t: number): void => {
  world.send({ type: 'tick', delta: (t - last) / 20 })
  last = t
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
