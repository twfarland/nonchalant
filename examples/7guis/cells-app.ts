// The Cells UI over the engine in cells.ts: 26 columns × 99 rows of inputs,
// each showing its computed value through a binding; focus reveals the raw
// formula, Enter/blur commits.

import { untracked } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { div, input, table, tbody, td, th, tr } from '@nonchalant/dom/tags'
import { createSheet } from './cells.ts'

const sheet = createSheet()
const COLS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
const ROWS = Array.from({ length: 99 }, (_, i) => i + 1)

const cellInput = (key: string) =>
  input({
    class: 'cell',
    value: () => String(sheet.value(key)),
    onfocus: (e) => {
      const el = e.currentTarget
      el.value = untracked(() => (sheet.formulas()[key] ?? ''))
    },
    onblur: (e) => {
      const el = e.currentTarget
      sheet.set(key, el.value)
      el.value = String(untracked(() => sheet.value(key)))
    },
    onkeydown: (e) => {
      if (e.key === 'Enter') e.currentTarget.blur()
    },
  })

mount(document.getElementById('app')!, div({ class: 'cells' },
  table({},
    tbody({},
      tr({}, th({}), ...COLS.map((c) => th({}, c))),
      ...ROWS.map((r) =>
        tr({ key: r },
          th({}, String(r)),
          ...COLS.map((c) => td({ key: c }, cellInput(`${c}${r}`)))))))))
