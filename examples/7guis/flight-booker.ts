// 7GUIs 3/7 — Flight booker: constraint logic lives in derives.

import { cell, derive } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, option, select } from '@nonchalant/dom/tags'
import { input } from '@nonchalant/dom/tags'

type Mode = 'one-way flight' | 'return flight'

const mode = cell<Mode>('one-way flight')
const depart = cell('2026-09-01')
const back = cell('2026-09-01')

const parse = (s: string): number => {
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : Number.NaN
}
const departOk = derive(() => Number.isFinite(parse(depart())))
const backOk = derive(() => mode() === 'one-way flight' || Number.isFinite(parse(back())))
const bookable = derive(
  () => departOk() && backOk() && (mode() === 'one-way flight' || parse(back()) >= parse(depart())),
)

mount(document.getElementById('app')!, div({ class: 'card' },
  select({ onchange: (e: Event) => mode.cast((e.target as HTMLSelectElement).value as Mode) },
    option({}, 'one-way flight'),
    option({}, 'return flight')),
  input({
    value: depart,
    style: () => (departOk() ? '' : 'background: salmon'),
    oninput: (e: Event) => depart.cast((e.target as HTMLInputElement).value),
  }),
  input({
    value: back,
    disabled: () => mode() === 'one-way flight',
    style: () => (backOk() ? '' : 'background: salmon'),
    oninput: (e: Event) => back.cast((e.target as HTMLInputElement).value),
  }),
  button({
    disabled: () => !bookable(),
    onclick: () => alert(`You have booked a ${mode()} on ${depart()}${mode() === 'return flight' ? ` returning ${back()}` : ''}.`),
  }, 'Book')))
