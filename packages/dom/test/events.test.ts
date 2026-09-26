// @vitest-environment happy-dom
//
// Event handlers: the authoring check as a pure function, and the one stable
// listener per event type per element whose handler swaps without a DOM call.

import { describe, it, expect, vi } from 'vitest'
import { dropHandlers, handlerProblem, setHandler } from '../src/events.ts'

describe('handlerProblem', () => {
  const fn = (): void => {}
  const cases: [name: string, value: unknown, problem: string | undefined][] = [
    ['onclick', fn, undefined],
    ['onpointerdown', fn, undefined],
    ['onClick', fn, 'onClick: event names are lowercase'],
    ['onclick', 'alert(1)', 'onclick must be a function'],
    ['onclick', 0, 'onclick must be a function'],
    ['onclick', true, 'onclick must be a function'],
    ['onclick', null, undefined],
    ['onclick', undefined, undefined],
    ['onclick', false, undefined],
  ]
  for (const [name, value, problem] of cases) {
    it(`${name}=${typeof value === 'function' ? 'a function' : String(value)} is ${problem ?? 'fine'}`, () => {
      expect(handlerProblem(name, value)).toBe(problem)
    })
  }
})

describe('setHandler', () => {
  it('adds one listener for the first handler and swaps later handlers without touching the DOM', () => {
    const el = document.createElement('button')
    const add = vi.spyOn(el, 'addEventListener')
    const first = vi.fn()
    const second = vi.fn()
    setHandler(el, 'onclick', first)
    setHandler(el, 'onclick', second)
    el.click()
    expect(add).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(0)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('calls the handler with the element as this', () => {
    const el = document.createElement('button')
    let self: unknown
    setHandler(el, 'onclick', function (this: unknown) {
      self = this
    })
    el.click()
    expect(self).toBe(el)
  })

  it('a cleared handler stops firing, and a new one fires once per event', () => {
    const el = document.createElement('button')
    const first = vi.fn()
    const again = vi.fn()
    setHandler(el, 'onclick', first)
    setHandler(el, 'onclick', null)
    el.click()
    setHandler(el, 'onclick', again)
    el.click()
    expect(first).toHaveBeenCalledTimes(0)
    expect(again).toHaveBeenCalledTimes(1)
  })

  it('keeps event types apart', () => {
    const el = document.createElement('input')
    const click = vi.fn()
    const input = vi.fn()
    setHandler(el, 'onclick', click)
    setHandler(el, 'oninput', input)
    el.dispatchEvent(new Event('input'))
    expect(click).toHaveBeenCalledTimes(0)
    expect(input).toHaveBeenCalledTimes(1)
  })

  it('an element with dropped handlers still has its listener, which then does nothing', () => {
    const el = document.createElement('button')
    const remove = vi.spyOn(el, 'removeEventListener')
    const handler = vi.fn()
    setHandler(el, 'onclick', handler)
    dropHandlers(el)
    el.click()
    expect(handler).toHaveBeenCalledTimes(0)
    expect(remove).toHaveBeenCalledTimes(0)
  })
})
