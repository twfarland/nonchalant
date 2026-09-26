// Wires a page's demo slots to the demo modules, highlights its static code
// samples, and draws its architecture diagrams on demand. Every page of the
// site loads this one script; each loads only the demos it has slots for.

import { demos } from './demos.ts'
import { highlight } from './highlight.ts'
import { showSources } from './sources.ts'

for (const root of document.querySelectorAll('[data-demo]')) {
  const id = root.getAttribute('data-demo') ?? ''
  const stage = root.querySelector('[data-stage]')
  const load = demos[id]
  if (stage === null || load === undefined) continue
  load()
    .then((demo) => {
      showSources(root, demo.sources)
      demo.run(stage)
    })
    .catch((e: unknown) => {
      // one broken demo must not take the page down with it
      stage.textContent = 'this demo failed to start — see the console'
      console.error(`demo "${id}" failed`, e)
    })
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
