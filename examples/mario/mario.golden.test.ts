// @vitest-environment happy-dom
//
// The golden budgets, asserted in CI:
//   - ONE view yield total: the view generator yields its binding tree once
//     and never resumes; every frame flows through attribute bindings.
//   - ≤ 3 DOM writes per frame, zero structural ops after mount.
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
  structure: number
  reset(): void
  restore(): void
}

// count every way the sink can touch the DOM: attributes, text, structure
const spyDomWrites = (): WriteCounts => {
  const counts = { attrs: 0, structure: 0 }
  const ep = Element.prototype
  const np = Node.prototype
  const origSet = ep.setAttribute
  const origRemove = ep.removeAttribute
  const origInsert = np.insertBefore
  const origRemoveChild = np.removeChild
  const dataDesc = Object.getOwnPropertyDescriptor(CharacterData.prototype, 'data')!
  ep.setAttribute = function (this: Element, ...args: [string, string]) {
    counts.attrs++
    return origSet.apply(this, args)
  }
  ep.removeAttribute = function (this: Element, ...args: [string]) {
    counts.attrs++
    return origRemove.apply(this, args)
  }
  np.insertBefore = function (this: Node, ...args: [Node, Node | null]) {
    counts.structure++
    return origInsert.apply(this, args) as Node
  } as typeof np.insertBefore
  np.removeChild = function (this: Node, ...args: [Node]) {
    counts.structure++
    return origRemoveChild.apply(this, args) as Node
  } as typeof np.removeChild
  Object.defineProperty(CharacterData.prototype, 'data', {
    configurable: true,
    get: dataDesc.get!,
    set(this: CharacterData, v: string) {
      counts.attrs++
      dataDesc.set!.call(this, v)
    },
  })
  return {
    get attrs() {
      return counts.attrs
    },
    get structure() {
      return counts.structure
    },
    reset: () => {
      counts.attrs = 0
      counts.structure = 0
    },
    restore: () => {
      ep.setAttribute = origSet
      ep.removeAttribute = origRemove
      np.insertBefore = origInsert
      np.removeChild = origRemoveChild
      Object.defineProperty(CharacterData.prototype, 'data', dataDesc)
    },
  }
}

describe('mario golden budgets', () => {
  it('one view yield total; ≤ 3 DOM writes per frame; no structural ops after mount', async () => {
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
      for (let f = 0; f < 120; f++) {
        if (f === 30) world.cast({ type: 'arrows', x: 1, y: 1 })
        if (f === 32) world.cast({ type: 'arrows', x: 1, y: 0 })
        spy.reset()
        world.cast({ type: 'tick', delta: 0.8 })
        await tick()
        maxWritesPerFrame = Math.max(maxWritesPerFrame, spy.attrs)
        expect(spy.structure).toBe(0) // bindings only — no node churn, ever
      }
      expect(maxWritesPerFrame).toBeLessThanOrEqual(3)
      expect(maxWritesPerFrame).toBeGreaterThan(0) // the world did move
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
