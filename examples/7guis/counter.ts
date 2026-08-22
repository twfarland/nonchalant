// 7GUIs 1/7 — Counter.

import { cell } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { button, div, input } from '@nonchalant/dom/tags'

const count = cell(0)

mount(document.getElementById('app')!, div({},
  input({ readonly: true, value: () => String(count()) }),
  button({ onclick: () => count.send(count() + 1) }, 'Count')))
