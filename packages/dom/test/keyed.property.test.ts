// @vitest-environment happy-dom
//
// Keyed reconciliation against a model: for random reorders, inserts, and
// removals the DOM ends in the new order, every surviving key keeps its node,
// and the number of moves is exactly survivors − LIS(old positions) — the
// minimum any keyed diff can do.

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { cell } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { li, ul } from '@nonchalant/dom/tags'
import { keepers } from '../src/render.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Reference LIS length, O(n²): the model the O(n log n) keepers() must match. */
const lisLength = (xs: readonly number[]): number => {
  const best: number[] = []
  let max = 0
  for (let i = 0; i < xs.length; i++) {
    let b = 1
    for (let j = 0; j < i; j++) if ((xs[j] as number) < (xs[i] as number)) b = Math.max(b, (best[j] as number) + 1)
    best[i] = b
    max = Math.max(max, b)
  }
  return max
}

// old list: distinct keys; new list: a shuffled subset of them plus fresh keys
const lists = fc
  .uniqueArray(fc.integer({ min: 0, max: 60 }), { maxLength: 30 })
  .chain((old) =>
    fc
      .tuple(
        fc.shuffledSubarray(old),
        fc.uniqueArray(fc.integer({ min: 100, max: 160 }), { maxLength: 8 }),
        fc.array(fc.nat(), { maxLength: 8 }),
      )
      .map(([kept, fresh, spots]) => {
        const next = [...kept]
        fresh.forEach((k, i) => next.splice((spots[i] ?? 0) % (next.length + 1), 0, k))
        return { old, next }
      }),
  )

describe('keyed reorder property', () => {
  it('keepers marks an increasing run as long as the true LIS, skipping new items', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1, max: 40 }), { maxLength: 40 }), (from) => {
        const keep = keepers(from)
        const kept = from.filter((_, i) => keep[i] === true)
        expect(kept.every((v) => v >= 0)).toBe(true)
        expect(kept.every((v, i) => i === 0 || (kept[i - 1] as number) < v)).toBe(true)
        expect(kept.length).toBe(lisLength(from.filter((v) => v >= 0)))
      }),
    )
  })

  it('DOM order matches, surviving nodes are reused, and moves = survivors − LIS', async () => {
    await fc.assert(
      fc.asyncProperty(lists, async ({ old, next }) => {
        const root = document.createElement('div')
        document.body.appendChild(root)
        const keys = cell(old)
        const view = mount(root, ul({}, () => keys().map((k) => li({ key: k }, String(k)))))
        const before = new Map([...root.querySelectorAll('li')].map((el) => [el.textContent, el]))

        let moves = 0
        const proto = Node.prototype
        const orig = proto.insertBefore
        proto.insertBefore = function <T extends Node>(this: Node, node: T, child: Node | null): T {
          if (node.isConnected) moves++
          return orig.call(this, node, child) as T
        }
        try {
          keys.cast(next)
          await tick()
        } finally {
          proto.insertBefore = orig
        }

        const after = [...root.querySelectorAll('li')]
        expect(after.map((el) => Number(el.textContent))).toEqual(next)
        for (const el of after) {
          const prior = before.get(el.textContent)
          if (prior !== undefined) expect(el).toBe(prior)
        }
        const survivors = next.filter((k) => old.includes(k)).map((k) => old.indexOf(k))
        expect(moves).toBe(survivors.length - lisLength(survivors))

        view[Symbol.dispose]()
        keys[Symbol.dispose]()
        root.remove()
      }),
      { numRuns: 150 },
    )
  })
})
