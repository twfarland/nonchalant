// @vitest-environment happy-dom
//
// A smoke test of the panel: the tree, the filtered timeline, a picked yield's
// patch and reconstructed state, keyboard focus in the tree, and teardown.

import { describe, it, expect } from 'vitest'
import { flush, spawn } from '@nonchalant/core'
import type { Cast, Proc } from '@nonchalant/core'
import { mountInspector } from '@nonchalant/inspect'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await tick()
  flush()
}

type Msg = Cast<{ type: 'inc' }>

const counter: Proc<{ n: number }, Msg, void> = async function* counterBody(self) {
  let state = { n: 0 }
  for await (const msg of self) {
    switch (msg.type) {
      case 'inc':
        state = { ...state, n: state.n + 1 }
        break
    }
    yield state
  }
}

const buttonNamed = (root: Element, text: string): HTMLButtonElement =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement

describe('mountInspector', () => {
  it('renders the tree, filters the timeline, and time-travels to a picked yield', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const panel = mountInspector(el)
    const a = spawn(counter, undefined, { initial: { n: 0 } })
    const b = spawn(counter, undefined, { initial: { n: 100 } })
    a.cast({ type: 'inc' })
    a.cast({ type: 'inc' })
    b.cast({ type: 'inc' })
    await settle()

    const items = [...el.querySelectorAll('[role="treeitem"]')]
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining('counterBody'), expect.stringContaining('counterBody')])
    expect(items.map((i) => i.getAttribute('tabindex'))).toEqual(['0', '-1'])
    expect(items.map((i) => i.querySelector('.nci-badges')?.textContent)).toEqual(['', ''])
    expect(el.querySelectorAll('.nci-timeline button')).toHaveLength(8) // 2 spawns, 3 casts, 3 yields

    ;(items[0] as HTMLElement).click()
    await settle()
    expect(items[0]!.getAttribute('aria-selected')).toBe('true')
    expect(el.querySelectorAll('.nci-timeline button')).toHaveLength(5)
    expect(el.textContent).toContain('n: 2')

    // the first yield of `a`: its patch, and `a` as it was then
    const firstYield = [...el.querySelectorAll<HTMLButtonElement>('.nci-yield')].at(-1)!
    firstYield.click()
    await settle()
    expect(firstYield.getAttribute('aria-pressed')).toBe('true')
    const ops = [...el.querySelectorAll('.nci-ops pre')].map((p) => p.textContent)
    expect(ops).toEqual(['["set","/n",1]'])
    expect(el.querySelector('.nci-number')?.textContent).toBe('1')

    buttonNamed(el, 'Back to live').click()
    await settle()
    expect(el.querySelector('.nci-ops')).toBeNull()
    expect(el.querySelector('.nci-number')?.textContent).toBe('2')

    panel[Symbol.dispose]()
    expect(el.children).toHaveLength(0)
    a[Symbol.dispose]()
    b[Symbol.dispose]()
  })

  it('moves focus through the tree with the arrow keys and selects with Enter', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const panel = mountInspector(el)
    const a = spawn(counter, undefined)
    const b = spawn(counter, undefined)
    await settle()
    const items = [...el.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    items[0]!.focus()
    items[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(items[1])
    items[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()
    expect(items[1]!.getAttribute('aria-selected')).toBe('true')
    panel[Symbol.dispose]()
    a[Symbol.dispose]()
    b[Symbol.dispose]()
  })
})
