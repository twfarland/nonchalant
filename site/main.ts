// Wires the page's demo slots to the demo modules. Every source shown is
// imported twice — once as code that runs, once as text that is displayed — so
// a listing can never drift from the thing above it. Demos that reach into a
// module of their own (mario's physics, the agent's loop, the worker's
// grinder) list that file too: the interesting part is not always in the file
// that mounts.

import { highlight } from './highlight.ts'
import { showSources, type Source } from './sources.ts'

import { run as counter } from './demos/counter.ts'
import { run as todos } from './demos/todos.ts'
import { run as typeahead } from './demos/typeahead.ts'
import { run as form } from './demos/form.ts'
import { run as drag } from './demos/drag.ts'
import { run as shared } from './demos/shared.ts'
import { run as worker } from './demos/worker.ts'
import { run as mario } from './demos/mario.ts'
import { run as agentDemo } from './demos/agent.ts'

import counterSrc from './demos/counter.ts?raw'
import todosSrc from './demos/todos.ts?raw'
import typeaheadSrc from './demos/typeahead.ts?raw'
import formSrc from './demos/form.ts?raw'
import dragSrc from './demos/drag.ts?raw'
import sharedSrc from './demos/shared.ts?raw'
import workerSrc from './demos/worker.ts?raw'
import marioSrc from './demos/mario.ts?raw'
import agentSrc from './demos/agent.ts?raw'

import marioProcessSrc from '../examples/mario/mario.ts?raw'
import grinderSrc from '../examples/worker/primes.ts?raw'
import grindWorkerSrc from './demos/grind.worker.ts?raw'
import agentLoopSrc from '../examples/agent/agent.ts?raw'
import agentToolsSrc from '../examples/agent/tools.ts?raw'

interface Demo {
  id: string
  sources: Source[]
  run(host: Element): Disposable
}

const demos: Demo[] = [
  { id: 'counter', sources: [{ label: 'counter.ts', src: counterSrc }], run: counter },
  { id: 'todos', sources: [{ label: 'todos.ts', src: todosSrc }], run: todos },
  { id: 'typeahead', sources: [{ label: 'typeahead.ts', src: typeaheadSrc }], run: typeahead },
  { id: 'form', sources: [{ label: 'form.ts', src: formSrc }], run: form },
  { id: 'drag', sources: [{ label: 'drag.ts', src: dragSrc }], run: drag },
  { id: 'shared', sources: [{ label: 'shared.ts', src: sharedSrc }], run: shared },
  {
    id: 'worker',
    sources: [
      { label: 'worker.ts', src: workerSrc },
      { label: 'primes.ts — the process', src: grinderSrc },
      { label: 'grind.worker.ts — the host', src: grindWorkerSrc },
    ],
    run: worker,
  },
  {
    id: 'mario',
    sources: [
      { label: 'mario.ts — the process and the view', src: marioProcessSrc },
      { label: 'demo.ts — mounting it', src: marioSrc },
    ],
    run: mario,
  },
  {
    id: 'agent',
    sources: [
      { label: 'agent.ts — the loop', src: agentLoopSrc },
      { label: 'tools.ts — tools as processes', src: agentToolsSrc },
      { label: 'demo.ts — the page', src: agentSrc },
    ],
    run: agentDemo,
  },
]

for (const demo of demos) {
  const root = document.querySelector(`[data-demo="${demo.id}"]`)
  if (root === null) continue

  showSources(root, demo.sources)

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

// Architecture diagrams: mermaid is loaded the first time one is opened, so the
// page costs nothing for readers who never expand them.
let mermaidReady: Promise<{ render(id: string, text: string): Promise<{ svg: string }> }> | null = null

const loadMermaid = async (): Promise<{ render(id: string, text: string): Promise<{ svg: string }> }> => {
  if (mermaidReady === null) {
    mermaidReady = import('mermaid').then(({ default: mermaid }) => {
      const dark = matchMedia('(prefers-color-scheme: dark)').matches
      mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'neutral', fontFamily: 'inherit' })
      return mermaid
    })
  }
  return mermaidReady
}

for (const [i, figure] of [...document.querySelectorAll('details.diagram')].entries()) {
  const target = figure.querySelector('[data-mermaid]')
  if (target === null) continue
  const text = (target.textContent ?? '').trim()
  let drawn = false
  figure.addEventListener('toggle', () => {
    if (drawn || !(figure as HTMLDetailsElement).open) return
    drawn = true
    void loadMermaid()
      .then((mermaid) => mermaid.render(`diagram-${i}`, text))
      .then(({ svg }) => {
        target.innerHTML = svg
      })
      .catch((e: unknown) => {
        // a diagram that will not draw is a diagram you can still read
        console.error('diagram failed to render', e)
      })
  })
}
