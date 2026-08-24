// @vitest-environment happy-dom
//
// The site's demos are documentation that executes, so a demo that stops
// rendering is a broken doc page. This mounts each one the way the page does
// and drives the interactions the captions promise.

import { describe, it, expect } from 'vitest'
import { flush } from '@nonchalant/core'
import { highlight } from './highlight.ts'
import { run as counter } from './demos/counter.ts'
import { run as todos } from './demos/todos.ts'
import { run as typeahead } from './demos/typeahead.ts'
import { run as form } from './demos/form.ts'
import { run as drag } from './demos/drag.ts'
import { run as shared } from './demos/shared.ts'
import { run as worker } from './demos/worker.ts'
import { run as mario } from './demos/mario.ts'
import { run as agent } from './demos/agent.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const host = (): HTMLElement => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

const settle = async (): Promise<void> => {
  await tick()
  flush()
}

describe('site demos', () => {
  it('counter counts both ways, and same-tick clicks queue instead of racing', async () => {
    const el = host()
    counter(el)
    await settle()
    const [minus, plus] = [...el.querySelectorAll('button')]
    expect(el.querySelector('.count')?.textContent).toBe('0')

    plus?.click()
    await settle()
    expect(el.querySelector('.count')?.textContent).toBe('1')

    // three clicks in one tick: deltas queue in the mailbox and all three land,
    // which a read-modify-write (`send(count() - 1)`) would lose
    minus?.click()
    minus?.click()
    minus?.click()
    await settle()
    expect(el.querySelector('.count')?.textContent).toBe('-2')
  })

  it('todos renders its seed rows, adds, toggles, and removes', async () => {
    const el = host()
    todos(el)
    await settle()
    expect(el.querySelectorAll('li').length).toBe(2)

    const field = el.querySelector('input[type="text"]') as HTMLInputElement
    field.value = 'write the docs'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()
    expect(el.querySelectorAll('li').length).toBe(3)
    expect(field.value).toBe('') // the field clears itself

    const secondRow = el.querySelectorAll('li')[1] as HTMLElement
    ;(secondRow.querySelector('input[type="checkbox"]') as HTMLInputElement).click()
    await settle()
    expect(secondRow.querySelector('span')?.getAttribute('class')).toBe('done')

    ;(secondRow.querySelector('button') as HTMLButtonElement).click()
    await settle()
    expect(el.querySelectorAll('li').length).toBe(2)
  })

  it('typeahead starts empty and searches on input', async () => {
    const el = host()
    typeahead(el)
    await settle()
    expect(el.querySelector('.muted')?.textContent).toBe('0 matches')

    const field = el.querySelector('input') as HTMLInputElement
    field.value = 'berry'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(el.querySelector('.muted')?.textContent).toBe('searching…')

    await new Promise((resolve) => setTimeout(resolve, 500)) // the fake API's latency
    flush()
    expect(el.querySelectorAll('li').length).toBeGreaterThan(0)
  })

  it('form replies to ask() with the outcome, both ways', async () => {
    const el = host()
    form(el)
    await settle()
    expect(el.querySelector('.readout')?.textContent).toBe('awaiting submit')

    const field = el.querySelector('input') as HTMLInputElement
    const submit = el.querySelector('button') as HTMLButtonElement

    field.value = 'nope'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    submit.click()
    await new Promise((resolve) => setTimeout(resolve, 800))
    flush()
    expect(el.querySelector('.readout')?.textContent).toBe('that is not an email')

    field.value = 'me@example.com'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    submit.click()
    await new Promise((resolve) => setTimeout(resolve, 800))
    flush()
    expect(el.querySelector('.readout')?.textContent).toBe('signed up')
  })

  it('drag renders a draggable box', async () => {
    const el = host()
    drag(el)
    await settle()
    expect(el.querySelector('.dragfield')).not.toBeNull()
    expect(el.querySelector('.dragbox')?.textContent).toBe('drag me')
  })

  it('shared state: two panels built apart move together', async () => {
    const el = host()
    shared(el)
    await settle()
    const readout = (): string => el.querySelector('.readout')?.textContent ?? ''
    expect(readout()).toBe('0 items · $0')

    const add = [...el.querySelectorAll('button')].find((b) => b.textContent === 'add boots')
    add?.click()
    await settle()
    expect(readout()).toBe('1 item · $120') // panel two saw panel one's message
    expect(el.querySelectorAll('li').length).toBe(1)

    const clear = [...el.querySelectorAll('button')].find((b) => b.textContent === 'clear')
    clear?.click()
    await settle()
    expect(readout()).toBe('0 items · $0')
  })

  // no Worker in a DOM shim, so this exercises the demo's other host: the same
  // registry exposed in this thread over a MessageChannel. What is under test
  // is that the page's code path does not care which one it got.
  it('worker: the grinder is reached over a port and counts up', async () => {
    const el = host()
    const demo = worker(el)
    await settle()
    const readout = (): string => el.querySelector('.readout')?.textContent ?? ''
    expect(readout()).toBe('0 tested · 0 primes · last —')

    const start = [...el.querySelectorAll('button')].find((b) => b.textContent === 'grind primes')
    start?.click()
    await new Promise((resolve) => setTimeout(resolve, 300)) // a couple of chunks
    flush()
    expect(Number(readout().split(' ')[0])).toBeGreaterThan(0)

    const stop = [...el.querySelectorAll('button')].find((b) => b.textContent === 'stop')
    stop?.click()
    await settle()
    demo[Symbol.dispose]()
  })

  // the claim the section around it makes: this is the same machinery as the
  // counter above, so it is tested the same way
  it('agent: reaches for a tool, streams an answer, and parks on approval', async () => {
    const el = host()
    const demo = agent(el)
    await settle()
    const readout = (): string => el.querySelector('.readout')?.textContent ?? ''
    const waitFor = async (ready: () => boolean, what: string): Promise<void> => {
      for (let i = 0; i < 500 && !ready(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 4))
        flush()
      }
      if (!ready()) throw new Error(`never reached: ${what}`)
    }
    expect(readout()).toBe('no answer yet')

    const press = (label: string): void => {
      const b = [...el.querySelectorAll('button')].find((x) => x.textContent === label)
      b?.click()
    }
    press('ask') // the field starts on "what is a patch?"
    await waitFor(() => el.querySelectorAll('li').length >= 2, 'the tool call')
    expect(el.querySelectorAll('li')[1]?.textContent).toContain('search')
    await waitFor(() => readout().includes('patches'), 'the streamed answer')

    // and the tool that waits for a person: no reply, no progress
    const field = el.querySelector('input') as HTMLInputElement
    field.value = 'refund 20'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await settle() // the field's cell takes a turn to publish, like any process
    press('ask')
    await waitFor(() => el.textContent?.includes('approve refund 20?') === true, 'the approval request')
    press('yes')
    await waitFor(() => readout().includes('approved'), 'the decision to reach the agent')

    demo[Symbol.dispose]()
  }, 20_000) // a stubbed model still takes its time, on purpose

  it('mario: the stage owns its keyboard and the sprite tracks the walk', async () => {
    const el = host()
    const demo = mario(el)
    await settle()
    const stage = el.querySelector('.mariostage') as HTMLElement
    const sprite = (): string => el.querySelector('img')?.getAttribute('src') ?? ''
    expect(stage.getAttribute('tabindex')).toBe('0') // arrows belong to the stage, not the page
    expect(sprite()).toContain('stand/left')

    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 120)) // a few animation frames
    flush()
    expect(sprite()).toContain('walk/right')
    const left = el.querySelector('img')?.getAttribute('style') ?? ''
    expect(left).toContain('left: ')

    stage.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 120))
    flush()
    expect(sprite()).toContain('stand/right')
    demo[Symbol.dispose]()
  })
})

describe('the plain highlighter', () => {
  it('marks keywords, strings, and comments', () => {
    expect(highlight('const x = 1')).toBe('<span class="k">const</span> x = 1')
    expect(highlight("'hi'")).toBe('<span class="s">\'hi\'</span>')
    expect(highlight('// note')).toBe('<span class="c">// note</span>')
  })

  it('escapes markup so source can never become HTML', () => {
    expect(highlight('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d')
    expect(highlight('"<script>"')).toBe('<span class="s">"&lt;script&gt;"</span>')
  })

  it('does not find keywords inside strings or comments', () => {
    expect(highlight("'const'")).toBe('<span class="s">\'const\'</span>')
    expect(highlight('// const')).toBe('<span class="c">// const</span>')
    expect(highlight('constant')).toBe('constant') // whole words only
  })

  it('handles escaped quotes and unterminated comments without hanging', () => {
    expect(highlight("'it\\'s'")).toBe('<span class="s">\'it\\\'s\'</span>')
    expect(highlight('/* open')).toBe('<span class="c">/* open</span>')
  })
})
