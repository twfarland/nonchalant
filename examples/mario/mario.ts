// Mario — ported from ../sprezzatura-acto-mario (the golden demo, M8).
// Physics is verbatim from the original. The architecture is not: in the old
// stack, the input signal fired on BOTH animation frames and arrow events
// (acto's map was combineLatest with holes), so key-repeat double-stepped the
// physics. Here arrows are plain state inside the process and only `tick`
// steps the world — the bug is impossible by construction, and the golden
// test asserts it.
//
// The view is a process that yields ONCE: a tree whose holes are bindings.
// Movement flows through two attribute bindings (style, and src on
// walk/jump/stand transitions); the generator never resumes. Frame-rate
// yields, frame-sized state (five numbers) — per docs/DESIGN.md guidance.

import type { Proc, Process, VNode } from '@nonchalant/core'
import { div, img } from '@nonchalant/dom/tags'

export interface MarioState {
  x: number
  y: number
  vx: number
  vy: number
  dir: 'LEFT' | 'RIGHT'
}

export interface Arrows {
  x: number
  y: number
}

export type MarioMsg =
  | { type: 'tick'; delta: number } // delta pre-scaled: milliseconds / 20, as the original's input signal did
  | { type: 'arrows'; x: number; y: number }

export const initialMario: MarioState = { x: 0, y: 0, vx: 0, vy: 0, dir: 'LEFT' }

// ---------- physics (verbatim from the original) ----------

const jump = (arrows: Arrows, m: MarioState): MarioState =>
  ({ ...m, vy: arrows.y > 0 && m.vy === 0 ? 16.0 : m.vy })

const gravity = (delta: number, m: MarioState): MarioState =>
  ({ ...m, vy: m.y > 0 ? m.vy - delta / 1.6 : 0 })

const walk = (arrows: Arrows, m: MarioState): MarioState => ({
  ...m,
  vx: arrows.x * 2,
  dir: arrows.x < 0 ? 'LEFT' : arrows.x > 0 ? 'RIGHT' : m.dir,
})

const physics = (delta: number, m: MarioState): MarioState => ({
  ...m,
  x: m.x + delta * m.vx,
  y: Math.max(0, m.y + delta * m.vy),
})

export const step = (delta: number, arrows: Arrows, m: MarioState): MarioState =>
  physics(delta, walk(arrows, jump(arrows, gravity(delta, m))))

// ---------- the process ----------

export const mario: Proc<MarioState, MarioMsg, void> = async function* (self) {
  let m = initialMario
  let arrows: Arrows = { x: 0, y: 0 }
  yield m
  for await (const msg of self) {
    if (msg.type === 'arrows') {
      // input is state, not a step: no yield, no physics — the double-step fix
      arrows = { x: msg.x, y: msg.y }
    } else {
      m = step(msg.delta, arrows, m)
      yield m
    }
  }
}

// ---------- the view (yields once; holes carry every frame) ----------

export type Dims = { w: number; h: number }

export const sprite = (m: MarioState): string => {
  const verb = m.y > 0 ? 'jump' : m.vx !== 0 ? 'walk' : 'stand'
  return `img/mario/${verb}/${m.dir === 'LEFT' ? 'left' : 'right'}.gif`
}

export function MarioView(m: Process<MarioState>, dims: Process<Dims>): VNode {
  return div(
    {
      style: () =>
        `width: ${dims().w}px; height: ${dims().h}px; background: rgb(174,238,238); position: fixed;`,
    },
    div({
      style: () =>
        `width: ${dims().w}px; height: 50px; background: rgb(74,167,43); position: fixed; bottom: 0px;`,
    }),
    img({
      src: () => sprite(m()),
      style: () => `position: fixed; z-index: 1; bottom: ${m().y + 46}px; left: ${m().x}px;`,
    }),
  )
}
