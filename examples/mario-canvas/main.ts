// The same Mario, retargeted: identical state process, identical physics,
// identical input wiring — only the renderer changed. A canvas "sink" for
// this scene is one tracked effect that redraws when the state it read
// changes.
//
// One canvas-only caveat: drawImage paints a gif's first frame, so the walk
// sprite doesn't cycle its legs here the way it does as an <img>. Position,
// direction, and jump/stand/walk sprite selection all behave identically.

import { cell, effect, spawn } from '@nonchalant/core'
import { initialMario, mario, sprite, type Dims, type MarioState } from '../mario/mario.ts'

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
    im.onload = () => draw(latest.m, latest.d) // repaint once the sprite arrives
    images.set(src, im)
  }
  return im
}

let latest = { m: initialMario as MarioState, d: { w: innerWidth, h: innerHeight } as Dims }

const draw = (m: MarioState, { w, h }: Dims): void => {
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  ctx.fillStyle = 'rgb(174,238,238)'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = 'rgb(74,167,43)'
  ctx.fillRect(0, h - 50, w, 50)
  const im = imageFor(sprite(m))
  if (im.complete && im.naturalWidth > 0) {
    // same anchor as the DOM version: mario's feet sit 46px above the bottom
    ctx.drawImage(im, m.x, h - 46 - im.naturalHeight - m.y)
  }
}

effect(() => {
  latest = { m: world(), d: dims() }
  draw(latest.m, latest.d)
})

let last = performance.now()
const frame = (t: number): void => {
  world.send({ type: 'tick', delta: (t - last) / 20 })
  last = t
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
