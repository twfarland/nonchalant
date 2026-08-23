// Wires the page's demo slots to the demo modules. Each demo's source is
// imported twice — once as code that runs, once as text that is displayed —
// so the listing under a demo is exactly the program above it.

import { highlight } from './highlight.ts'

import { run as counter } from './demos/counter.ts'
import { run as todos } from './demos/todos.ts'
import { run as typeahead } from './demos/typeahead.ts'
import { run as form } from './demos/form.ts'
import { run as drag } from './demos/drag.ts'
import { run as shared } from './demos/shared.ts'

import counterSrc from './demos/counter.ts?raw'
import todosSrc from './demos/todos.ts?raw'
import typeaheadSrc from './demos/typeahead.ts?raw'
import formSrc from './demos/form.ts?raw'
import dragSrc from './demos/drag.ts?raw'
import sharedSrc from './demos/shared.ts?raw'

interface Demo {
  id: string
  src: string
  run(host: Element): Disposable
}

const demos: Demo[] = [
  { id: 'counter', src: counterSrc, run: counter },
  { id: 'todos', src: todosSrc, run: todos },
  { id: 'typeahead', src: typeaheadSrc, run: typeahead },
  { id: 'form', src: formSrc, run: form },
  { id: 'drag', src: dragSrc, run: drag },
  { id: 'shared', src: sharedSrc, run: shared },
]

for (const demo of demos) {
  const root = document.querySelector(`[data-demo="${demo.id}"]`)
  if (root === null) continue

  const code = root.querySelector('[data-src]')
  if (code !== null) code.innerHTML = highlight(demo.src.trimEnd())

  const stage = root.querySelector('[data-stage]')
  if (stage === null) continue
  try {
    demo.run(stage)
  } catch (e) {
    // one broken demo must not take the page down with it
    stage.textContent = 'this demo failed to start — see the console'
    console.error(`demo "${demo.id}" failed`, e)
  }
}

// the static code samples in the prose get the same treatment
for (const block of document.querySelectorAll('pre > code[data-ts]')) {
  block.innerHTML = highlight((block.textContent ?? '').trim())
}
