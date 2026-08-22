// Form. The submit is a Call message: the form learns whether its own
// submission succeeded as a typed promise, instead of digging the outcome out
// of yielded status fields.
//
// The "backend" is a fake with latency so the demo is self-contained —
// addresses at taken.com are already registered, to show the failure path.

import { cell, spawn } from '@nonchalant/core'
import type { Call, Proc, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, form, input, p } from '@nonchalant/dom/tags'

const fakeSignup = (email: string): Promise<{ ok: boolean; error?: string }> =>
  new Promise((resolve) =>
    setTimeout(() => {
      if (email.endsWith('@taken.com')) resolve({ ok: false, error: 'that address is already registered' })
      else resolve({ ok: true })
    }, 400),
  )

type SignupState = { submitted: number }
type SignupMsg = Call<{ type: 'submit'; email: string }, { ok: boolean; error?: string }>

const signup: Proc<SignupState, SignupMsg, void> = async function* (self) {
  let submitted = 0
  yield { submitted }
  for await (const msg of self) {
    if (!msg.email.includes('@')) {
      msg.reply({ ok: false, error: 'that is not an email address' })
      continue
    }
    const res = await fakeSignup(msg.email)
    msg.reply(res)
    if (res.ok) {
      submitted++
      yield { submitted }
    }
  }
}

function SignupForm(): VNode {
  const store = spawn(signup, undefined, { initial: { submitted: 0 } })
  const status = cell('')
  return form({
      class: 'card',
      onsubmit: (e: Event) => {
        e.preventDefault()
        const el = (e.target as HTMLFormElement).elements.namedItem('email') as HTMLInputElement
        status.send('…')
        void store.ask({ type: 'submit', email: el.value }).then(
          (res) => status.send(res.ok ? 'welcome aboard' : (res.error ?? 'failed')),
          () => status.send('the signup process is unavailable'),
        )
      },
    },
    input({ name: 'email', placeholder: 'you@example.com (try someone@taken.com)' }),
    button({ type: 'submit' }, 'Sign up'),
    p({ class: 'status' }, status),
    div({ class: 'muted' }, () => `${store().submitted} signups this session`))
}

mount(document.getElementById('app')!, SignupForm())
