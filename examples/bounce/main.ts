// Bounce — one process, two renderers, same page. The physics process knows
// nothing about rendering; the left panel is the DOM sink (a keyed list of
// positioned divs), the right is a canvas redrawn by one tracked effect.
// Click either panel to add balls; both stay in lockstep because they are
// reading the same yields.

import { effect, spawn } from '@nonchalant/core'
import type { Cast, Proc, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { div, p } from '@nonchalant/dom/tags'

const W = 340
const H = 240
const R = 8

type Ball = { id: number; x: number; y: number; vx: number; vy: number; hue: number }
type World = { balls: Ball[] }
type Msg = Cast<{ type: 'tick'; delta: number }> | Cast<{ type: 'add'; x: number; y: number }>

const world: Proc<World, Msg, void> = async function* (self) {
  let balls: Ball[] = []
  let nextId = 1
  yield { balls }
  for await (const msg of self) {
    if (msg.type === 'add') {
      if (balls.length >= 40) balls = balls.slice(1)
      balls = [...balls, {
        id: nextId++,
        x: msg.x, y: msg.y,
        vx: (Math.random() - 0.5) * 6, vy: -3 - Math.random() * 3,
        hue: Math.floor(Math.random() * 360),
      }]
    } else {
      const d = msg.delta
      balls = balls.map((b) => {
        let { x, y, vx, vy } = b
        vy += 0.35 * d
        x += vx * d
        y += vy * d
        if (x < R) { x = R; vx = Math.abs(vx) }
        if (x > W - R) { x = W - R; vx = -Math.abs(vx) }
        if (y > H - R) { y = H - R; vy = -Math.abs(vy) * 0.85 }
        return { ...b, x, y, vx, vy }
      })
    }
    yield { balls }
  }
}

const sim = spawn(world, undefined, { initial: { balls: [] } })

const addAt = (e: MouseEvent): void => {
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
  sim.cast({ type: 'add', x: e.clientX - box.left, y: e.clientY - box.top })
}

// ---- renderer 1: the DOM sink (keyed list, style bindings) ----

function DomPanel(): VNode {
  return div({
    class: 'stage',
    style: `position: relative; width: ${W}px; height: ${H}px; overflow: hidden; cursor: crosshair;`,
    onclick: addAt,
  }, () => sim().balls.map((b) =>
    div({
      key: b.id,
      style: `position: absolute; width: ${R * 2}px; height: ${R * 2}px; border-radius: 50%;` +
        ` background: hsl(${b.hue} 70% 55%); transform: translate(${b.x - R}px, ${b.y - R}px);`,
    })))
}

// ---- renderer 2: a canvas, redrawn by one tracked effect ----

const canvas = document.createElement('canvas')
canvas.width = W
canvas.height = H
canvas.style.cursor = 'crosshair'
canvas.addEventListener('click', addAt as EventListener)
const ctx = canvas.getContext('2d')!

effect(() => {
  const { balls } = sim()
  ctx.clearRect(0, 0, W, H)
  for (const b of balls) {
    ctx.fillStyle = `hsl(${b.hue} 70% 55%)`
    ctx.beginPath()
    ctx.arc(b.x, b.y, R, 0, Math.PI * 2)
    ctx.fill()
  }
})

// ---- the page ----

mount(document.getElementById('app')!, div({ class: 'card', style: 'max-width: none; display: inline-block;' },
  p({ class: 'muted' }, 'Click either panel. One physics process; the DOM sink on the left, a canvas effect on the right.'),
  div({ style: 'display: flex; gap: 1rem; flex-wrap: wrap;' },
    div({}, p({ class: 'muted' }, 'DOM'), DomPanel()),
    div({ id: 'canvas-slot' }, p({ class: 'muted' }, 'canvas')))))

document.getElementById('canvas-slot')!.appendChild(canvas)

let last = performance.now()
const frame = (t: number): void => {
  sim.cast({ type: 'tick', delta: Math.min(3, (t - last) / 16) })
  last = t
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
