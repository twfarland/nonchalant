// Attribute typing harness — compiled, never run. The @ts-expect-error lines
// are load-bearing: if one stops erroring, the attribute types have loosened.

import { cell } from '@nonchalant/core'
import { h } from '../src/index.ts'
import type { Attrs } from '../src/index.ts'
import { a, button, div, form, input, label, td } from '../src/tags.ts'

const count = cell(0)
const name = cell('')

// ---------- values: plain, thunk, or process ----------

div({ class: 'card', id: 'main', title: () => `n=${count()}`, hidden: () => count() === 0 })
div({ tabindex: 0, role: 'button', lang: 'en', dir: 'ltr', style: 'color: red' })
div({ key: 0, exit: (el) => el.animate([], 100).finished })
div({ 'data-id': 3, 'data-state': () => 'open', 'aria-pressed': false, 'aria-label': 'close' })
div({ draggable: 'true', spellcheck: 'false', translate: 'no' })
input({ type: 'range', min: 0, max: 10, step: 1, value: count, readonly: true, maxlength: 20 })
input({ type: 'text', value: name, placeholder: 'name', disabled: () => count() > 3, autofocus: true })
input({ type: 'checkbox', checked: () => count() > 0 })
label({ for: 'email' })
a({ href: '/about', target: '_blank', rel: 'noopener' })
td({ colspan: 2, rowspan: 1 })
button({ disabled: null, title: undefined })

// @ts-expect-error — not an attribute
div({ onlick: () => {} })
// @ts-expect-error — the sink listens for "Click", which never fires: listeners are lowercase
div({ onClick: () => {} })
// @ts-expect-error — the sink stringifies attributes: an object renders "[object Object]"
div({ style: { color: 'red' } })
// @ts-expect-error — `class`, not the IDL property name
div({ className: 'x' })
// @ts-expect-error — setAttribute('innerhtml') is not markup
div({ innerHTML: '<b>hi</b>' })
// @ts-expect-error — boolean attribute
button({ disabled: 'no' })
// @ts-expect-error — a thunk must produce a matching value
button({ disabled: () => 'no' })
// @ts-expect-error — numeric attribute
div({ tabindex: true })
// @ts-expect-error — enumerated: `true` would render the invalid draggable=""
div({ draggable: true })
// @ts-expect-error — readonly IDL property, no attribute
div({ tagName: 'p' })
// @ts-expect-error — per-tag: a div has no `href`
div({ href: '/x' })

// ---------- listeners: the event type and currentTarget come from the tag ----------

button({
  onclick: (e) => {
    const x: number = e.clientX
    const el: HTMLButtonElement = e.currentTarget
    void x, el
  },
})
input({ oninput: (e) => name.cast(e.currentTarget.value) })
input({ onkeydown: (e) => e.key === 'Enter' && e.currentTarget.blur() })
form({
  onsubmit: (e) => {
    e.preventDefault()
    const f: HTMLFormElement = e.currentTarget
    void f.elements
  },
})
// a wider parameter annotation is still accepted
div({ onclick: (e: Event) => e.preventDefault() })
// a listener may be absent
div({ onclick: count() > 0 ? () => {} : undefined })

// @ts-expect-error — a click delivers a MouseEvent, not a KeyboardEvent
div({ onclick: (e: KeyboardEvent) => e.key })
// @ts-expect-error — a div's currentTarget has no value
div({ oninput: (e) => e.currentTarget.value })
// @ts-expect-error — listeners are not bindings: the handler must take the event it is given
div({ onclick: 'go()' })

// ---------- h(): typed by tag name, open for everything else ----------

h('div', { class: 'x', onclick: (e) => e.button })
h('svg', { viewBox: '0 0 10 10', width: 10, onclick: (e) => e.currentTarget.getBoundingClientRect() })
h('circle', { cx: 5, cy: 5, r: () => count(), fill: 'red' })
h('my-widget', { anything: 1, 'some-prop': () => 'x' })
// widening the tag to string is the escape for names the DOM lib doesn't know
h('div' as string, { popovertargetaction: 'show', 'x-custom': 1 })
const extra: Attrs = { 'hx-get': '/rows' }
h('div' as string, extra)

// @ts-expect-error — h() checks known tags like the named constructors
h('div', { onClick: () => {} })
// @ts-expect-error — h() checks known tags like the named constructors
h('input', { value: {} })
// @ts-expect-error — SVG listeners are typed too
h('svg', { onclick: (e: KeyboardEvent) => e.key })
