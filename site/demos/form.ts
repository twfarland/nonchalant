// A message that expects an answer is a `Call`. `call()` hands the caller a
// typed promise for its own outcome, so the submit button learns what happened
// instead of watching status fields go by. The compiler refuses to `cast` a
// call or `call` a cast.

import { cell, spawn } from '@nonchalant/core'
import type { Call, Cast, Proc } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, input, span } from '@nonchalant/dom/tags'

type Outcome = { ok: true } | { ok: false; error: string }
type State = { email: string; submitting: boolean }
type Msg =
  | Cast<{ type: 'set'; value: string }>
  | Call<{ type: 'submit' }, Outcome>

const signup: Proc<State, Msg, void> = async function* (self) {
  let s: State = { email: '', submitting: false }
  yield s

  for await (const msg of self) {
    if (msg.type === 'set') {
      s = { ...s, email: msg.value }
      yield s
      continue
    }
    s = { ...s, submitting: true }
    yield s
    await new Promise((resolve) => setTimeout(resolve, 700))     // stands in for the request
    msg.reply(s.email.includes('@') ? { ok: true } : { ok: false, error: 'that is not an email' })
    s = { ...s, submitting: false }
    yield s
  }
}

export function run(host: Element): Disposable {
  const form = spawn(signup, undefined, { initial: { email: '', submitting: false } })
  const outcome = cell('awaiting submit')

  const submit = async (): Promise<void> => {
    const res = await form.call({ type: 'submit' })      // res is typed Outcome
    outcome.cast(res.ok ? 'signed up' : res.error)
  }

  return mount(host, div({ class: 'stack' },
    div({ class: 'row' },
      input({
        type: 'email',
        placeholder: 'you@example.com',
        oninput: (e: Event) => form.cast({ type: 'set', value: (e.target as HTMLInputElement).value }),
      }),
      button({ onclick: () => void submit(), disabled: () => form().submitting }, 'Sign up')),
    span({ class: 'readout' }, () => (form().submitting ? 'submitting…' : outcome()))))
}
