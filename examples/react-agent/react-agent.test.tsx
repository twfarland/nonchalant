// @vitest-environment happy-dom
//
// The React console driven end to end with a scripted model: the transcript
// streams, a tool call lands in its row, the approval gate parks the agent
// until a button is pressed, and a killed agent comes back from its journal.

import { describe, it, expect, afterEach } from 'vitest'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Model, Plan } from '../agent/llm.ts'
import { App } from './app.tsx'
import { parts, type Parts } from './parts.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A model that says what it is told to, in order, and waits between words for a go-ahead. */
const scripted = (plans: Plan[]): Model & { asked: number; next(): void } => {
  const gates: (() => void)[] = []
  const model = {
    asked: 0,
    async plan(): Promise<Plan> {
      const plan = plans[model.asked++]
      if (plan === undefined) throw new Error('the script ran out')
      return plan
    },
    async *say(text: string): AsyncIterable<string> {
      for (const word of text.split(' ')) {
        await new Promise<void>((resolve) => gates.push(resolve))
        yield word
      }
    },
    async compose(): Promise<string> {
      return ''
    },
    next: () => gates.shift()?.(),
  }
  return model
}

let root: Root | undefined
let made: Parts | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  made?.dispose()
})

const start = async (model: Model): Promise<HTMLElement> => {
  const el = document.createElement('div')
  made = parts(model)
  root = createRoot(el)
  await act(async () => root!.render(<StrictMode><App parts={made!} /></StrictMode>))
  return el
}

/** Let processes step, the graph flush, and React commit — a few rounds, since a tool call is several hops. */
const settle = async (fn: () => void = () => {}): Promise<void> => {
  await act(async () => {
    fn()
    for (let i = 0; i < 20; i++) await tick()
  })
}

const ask = async (el: HTMLElement, question: string): Promise<void> => {
  const input = el.querySelector('input')!
  await settle(() => {
    // React tracks the input's value; set it the way a keystroke would
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(input, question)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle(() => el.querySelector('button')!.click())
}

const turns = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('.turn')].map((li) => li.textContent ?? '')

const button = (el: HTMLElement, label: string): HTMLButtonElement =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === label)!

describe('the React agent console', () => {
  it('streams the answer word by word into the last line, then settles it as a step', async () => {
    const model = scripted([{ tool: 'calc', args: '2 + 3 * 4' }, { answer: 'it is 14' }])
    const el = await start(model)
    await ask(el, 'what is 2 + 3 * 4?')

    expect(turns(el)).toStrictEqual(['youwhat is 2 + 3 * 4?', 'calc2 + 3 * 4 → calc says: 2 + 3 * 4 = 14', 'agent▌'])
    await settle(() => model.next())
    expect(turns(el).at(-1)).toBe('agentit▌')
    await settle(() => model.next())
    expect(turns(el).at(-1)).toBe('agentit is▌')
    await settle(() => model.next())
    expect(turns(el).at(-1)).toBe('agentit is 14')
    expect(el.textContent).toContain('calc: 1 calls')
  })

  it('parks on the approval gate until a person presses a button', async () => {
    const model = scripted([{ tool: 'refund', args: '20' }, { answer: 'refunded' }])
    const el = await start(model)
    await ask(el, 'refund 20')

    expect(el.querySelector('.gate')?.textContent).toContain('refund20')
    expect(turns(el).at(-1)).toBe('refund20 → working…')
    expect(el.textContent).toContain('waiting')
    expect(model.asked).toBe(1) // nothing moves while the person thinks

    await settle(() => button(el, 'approve').click())
    expect(el.querySelector('.gate')).toBeNull()
    expect(turns(el)[1]).toBe('refund20 → refund of 20 approved')
    await settle(() => model.next())
    expect(model.asked).toBe(2)
    expect(turns(el).at(-1)).toBe('agentrefunded')
  })

  it('comes back from its journal after the machine is killed', async () => {
    const model = scripted([{ tool: 'search', args: 'durable' }, { answer: 'a wrapper' }, { answer: 'still here' }])
    const el = await start(model)
    await ask(el, 'what is durable?')
    await settle(() => model.next())
    await settle(() => model.next())
    expect(turns(el).at(-1)).toBe('agenta wrapper')
    const before = turns(el)

    await settle(() => button(el, 'kill the machine').click())
    expect(turns(el)).toStrictEqual(before)
    expect(model.asked).toBe(2) // rehydrated, not re-asked
    expect(el.textContent).toContain('done')

    // the page talks to the new process, not the disposed one
    await ask(el, 'are you there?')
    await settle(() => model.next())
    await settle(() => model.next())
    expect(turns(el).slice(-2)).toStrictEqual(['youare you there?', 'agentstill here'])
  })
})
