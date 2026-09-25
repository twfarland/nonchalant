// @vitest-environment happy-dom
//
// The golden budgets, asserted in CI:
//   - ONE view yield total: the view generator yields its binding tree once
//     and never resumes; every frame flows through attribute bindings.
//   - exactly 2 DOM writes in the busiest frame (123 over the 120-frame run:
//     the sink skips writes the DOM already holds), zero structural ops and
//     zero property writes after mount.
// Plus the classic regression: holding a key down must not double-step the
// physics (merged input/frame streams in signal libraries did exactly that).

import { describe, it, expect } from 'vitest'
import { cell, spawn } from '@nonchalant/core'
import type { Self, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { MarioView, initialMario, mario, step, type Dims } from './mario.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface WriteCounts {
  attrs: number
  props: number
  structure: number
  reset(): void
  restore(): void
}

// count every way the sink can touch the DOM: attributes, text, interactive
// properties, and every structural entry point (insert, append, move, replace, remove)
const spyDomWrites = (): WriteCounts => {
  const counts = { attrs: 0, props: 0, structure: 0 }
  const restores: (() => void)[] = []
  const wrap = (proto: object, name: string, bump: () => void): void => {
    const target = proto as Record<string, unknown>
    const orig = target[name]
    if (typeof orig !== 'function') return
    target[name] = function (this: unknown, ...args: unknown[]) {
      bump()
      return (orig as (...a: unknown[]) => unknown).apply(this, args)
    }
    restores.push(() => {
      target[name] = orig
    })
  }
  const setter = (proto: object, name: string, bump: () => void): void => {
    const desc = Object.getOwnPropertyDescriptor(proto, name)
    if (desc?.set === undefined) return
    Object.defineProperty(proto, name, {
      configurable: true,
      ...(desc.get === undefined ? {} : { get: desc.get }),
      set(this: unknown, v: unknown) {
        bump()
        desc.set!.call(this, v)
      },
    })
    restores.push(() => Object.defineProperty(proto, name, desc))
  }
  const attr = (): void => void counts.attrs++
  const prop = (): void => void counts.props++
  const structure = (): void => void counts.structure++
  wrap(Element.prototype, 'setAttribute', attr)
  wrap(Element.prototype, 'removeAttribute', attr)
  setter(CharacterData.prototype, 'data', attr)
  for (const name of ['insertBefore', 'appendChild', 'replaceChild', 'removeChild']) wrap(Node.prototype, name, structure)
  for (const name of ['moveBefore', 'remove', 'replaceChildren']) wrap(Element.prototype, name, structure)
  wrap(CharacterData.prototype, 'remove', structure)
  setter(Node.prototype, 'textContent', structure)
  setter(HTMLInputElement.prototype, 'value', prop)
  setter(HTMLInputElement.prototype, 'checked', prop)
  setter(HTMLSelectElement.prototype, 'value', prop)
  setter(HTMLOptionElement.prototype, 'selected', prop)
  return {
    get attrs() {
      return counts.attrs
    },
    get props() {
      return counts.props
    },
    get structure() {
      return counts.structure
    },
    reset: () => {
      counts.attrs = 0
      counts.props = 0
      counts.structure = 0
    },
    restore: () => {
      while (restores.length > 0) restores.pop()!()
    },
  }
}

describe('mario golden budgets', () => {
  it('one view yield total; at most 2 DOM writes per frame; no structural ops after mount', async () => {
    const world = spawn(mario, undefined, { initial: initialMario })
    const dims = cell<Dims>({ w: 800, h: 600 })
    let viewYields = 0
    const view = spawn(async function* (_self: Self<never>): AsyncGenerator<VNode> {
      viewYields++
      yield MarioView(world, dims)
    }, undefined)

    const root = document.createElement('div')
    document.body.appendChild(root)
    const handle = mount(root, view)
    await tick()
    expect(root.querySelector('img')).not.toBeNull()

    const spy = spyDomWrites()
    try {
      // 120 frames of running right, jumping once mid-flight
      world.cast({ type: 'arrows', x: 1, y: 0 })
      let maxWritesPerFrame = 0
      let totalWrites = 0
      for (let f = 0; f < 120; f++) {
        if (f === 30) world.cast({ type: 'arrows', x: 1, y: 1 })
        if (f === 32) world.cast({ type: 'arrows', x: 1, y: 0 })
        spy.reset()
        world.cast({ type: 'tick', delta: 0.8 })
        await tick()
        maxWritesPerFrame = Math.max(maxWritesPerFrame, spy.attrs)
        totalWrites += spy.attrs
        expect(spy.structure).toBe(0) // bindings only — no node churn, ever
        expect(spy.props).toBe(0)
      }
      expect(maxWritesPerFrame).toBe(2) // the img's style, plus its src when the sprite changes
      expect(totalWrites).toBe(123)
      expect(viewYields).toBe(1) // the generator never resumed

      const img = root.querySelector('img')!
      expect(img.getAttribute('style')).toContain('left: ') // moving right all along
      const finalX = (world() as { x: number }).x
      expect(finalX).toBeGreaterThan(100)
    } finally {
      spy.restore()
      handle[Symbol.dispose]()
      view[Symbol.dispose]()
      world[Symbol.dispose]()
      dims[Symbol.dispose]()
    }
  })

  it('key-repeat cannot double-step: arrow messages alone move nothing', async () => {
    const world = spawn(mario, undefined, { initial: initialMario })
    world.cast({ type: 'arrows', x: 1, y: 0 })
    world.cast({ type: 'arrows', x: 1, y: 0 }) // key-repeat
    world.cast({ type: 'arrows', x: 1, y: 0 })
    await tick()
    expect(world()).toStrictEqual(initialMario) // no tick, no movement, no yield

    world.cast({ type: 'tick', delta: 1 })
    await tick()
    const one = step(1, { x: 1, y: 0 }, initialMario)
    expect(world()).toStrictEqual(one) // exactly one step, however many repeats arrived
    world[Symbol.dispose]()
  })

  it('physics matches the original: gravity pulls a jump back to the ground', () => {
    let m = step(1, { x: 0, y: 1 }, initialMario) // jump impulse
    expect(m.vy).toBe(16)
    let frames = 0
    while (m.y > 0 || frames === 0) {
      m = step(1, { x: 0, y: 0 }, m)
      frames++
      if (frames > 500) throw new Error('never landed')
    }
    expect(m.y).toBe(0)
    expect(frames).toBeGreaterThan(10) // a real arc, not a glitch
  })
})
