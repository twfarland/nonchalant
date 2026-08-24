// A demo can be spread over more than one file — mario's physics, the agent's
// loop, the worker's grinder — and the file that mounts is rarely the
// interesting one. When there is more than one, the listing gets tabs.

import { highlight } from './highlight.ts'

export interface Source {
  label: string
  src: string
}

/** Fill the `[data-src]` block under a demo, adding a tab row when there is more than one file. */
export function showSources(root: Element, sources: readonly Source[]): void {
  const code = root.querySelector('[data-src]')
  const first = sources[0]
  if (code === null || first === undefined) return

  const show = (source: Source): void => {
    code.innerHTML = highlight(source.src.trimEnd())
  }
  show(first)
  if (sources.length < 2) return

  const tabs = root.ownerDocument.createElement('div')
  tabs.className = 'src-tabs'
  const buttons = sources.map((source, i) => {
    const tab = root.ownerDocument.createElement('button')
    tab.type = 'button'
    tab.textContent = source.label
    tab.className = i === 0 ? 'src-tab on' : 'src-tab'
    tab.addEventListener('click', () => {
      for (const other of buttons) other.className = 'src-tab'
      tab.className = 'src-tab on'
      show(source)
    })
    tabs.appendChild(tab)
    return tab
  })
  code.closest('pre')?.before(tabs)
}
