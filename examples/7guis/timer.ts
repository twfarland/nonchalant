// 7GUIs 4/7 — Timer: a process owns the interval; the abort signal is the
// cleanup. Elapsed freezes at the duration and resumes if it is extended.

import { spawn } from '@nonchalant/core'
import type { Cast, Proc } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, input, label, meter, span } from '@nonchalant/dom/tags'

type TimerState = { duration: number; elapsed: number }
type TimerMsg = Cast<{ type: 'tick' }> | Cast<{ type: 'duration'; s: number }> | Cast<{ type: 'reset' }>

const timer: Proc<TimerState, TimerMsg, void> = async function* (self) {
  let duration = 10
  let elapsed = 0
  const iv = setInterval(() => self.cast({ type: 'tick' }), 100)
  self.signal.addEventListener('abort', () => clearInterval(iv))
  yield { duration, elapsed }
  for await (const msg of self) {
    if (msg.type === 'tick') {
      if (elapsed >= duration) continue // no state change, no yield
      elapsed = Math.min(duration, elapsed + 0.1)
    } else if (msg.type === 'duration') duration = msg.s
    else elapsed = 0
    yield { duration, elapsed }
  }
}

const t = spawn(timer, undefined, { initial: { duration: 10, elapsed: 0 } })

mount(document.getElementById('app')!, div({ class: 'card' },
  div({},
    label({}, 'Elapsed time: '),
    meter({ min: 0, max: () => t().duration, value: () => t().elapsed }),
    span({ class: 'value' }, () => ` ${t().elapsed.toFixed(1)}s`)),
  div({},
    label({}, 'Duration: '),
    input({
      type: 'range', min: 0, max: 60, value: () => String(t().duration),
      oninput: (e: Event) => t.cast({ type: 'duration', s: Number((e.target as HTMLInputElement).value) }),
    })),
  button({ onclick: () => t.cast({ type: 'reset' }) }, 'Reset')))
