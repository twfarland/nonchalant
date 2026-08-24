// 7GUIs 2/7 — Temperature converter: bidirectional sync, last edit wins,
// unparseable input leaves the other field alone.

import { cell } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { div, input, label } from '@nonchalant/dom/tags'

const celsius = cell('')
const fahrenheit = cell('')

const onCelsius = (e: Event): void => {
  const t = (e.target as HTMLInputElement).value
  celsius.cast(t)
  const c = Number.parseFloat(t)
  if (Number.isFinite(c)) fahrenheit.cast(String(Math.round(c * (9 / 5) + 32)))
}
const onFahrenheit = (e: Event): void => {
  const t = (e.target as HTMLInputElement).value
  fahrenheit.cast(t)
  const f = Number.parseFloat(t)
  if (Number.isFinite(f)) celsius.cast(String(Math.round((f - 32) * (5 / 9))))
}

mount(document.getElementById('app')!, div({ class: 'card' },
  input({ value: celsius, oninput: onCelsius }),
  label({}, ' Celsius = '),
  input({ value: fahrenheit, oninput: onFahrenheit }),
  label({}, ' Fahrenheit')))
