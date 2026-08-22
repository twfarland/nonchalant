// Form — request/response with ask() (docs/DECISIONS.md #9). The submit is a
// Call message: the form learns whether its own submission succeeded as a
// typed Promise, not by grovelling through yielded status fields.

import { cell, spawn } from '@nonchalant/core'
import type { Call, Proc, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, form, input, p } from '@nonchalant/dom/tags'

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
    await fetch('/api/signup', { method: 'POST', body: JSON.stringify({ email: msg.email }), signal: self.signal })
    submitted++
    msg.reply({ ok: true })
    yield { submitted }
  }
}

function SignupForm(): VNode {
  const store = spawn(signup, undefined, { initial: { submitted: 0 } })
  const status = cell('')
  return form({
      onsubmit: (e: Event) => {
        e.preventDefault()
        const el = (e.target as HTMLFormElement).elements.namedItem('email') as HTMLInputElement
        void store.ask({ type: 'submit', email: el.value }).then(
          (res) => status.send(res.ok ? 'welcome aboard' : (res.error ?? 'failed')),
          () => status.send('the signup process is unavailable'),
        )
      },
    },
    input({ name: 'email', placeholder: 'you@example.com' }),
    button({ type: 'submit' }, 'Sign up'),
    p({ class: 'status' }, status),
    div({}, () => `${store().submitted} signups this session`))
}

mount(document.getElementById('app')!, SignupForm())
