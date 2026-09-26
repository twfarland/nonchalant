// The inspector panel, built with nonchalant: one widget process for what is
// selected, bindings over the recording for everything else. Rows are cached
// per recorded object (entries and nodes are immutable), so an event re-runs
// the list bindings but hands the sink reference-equal rows it skips.

import { spawn } from '@nonchalant/core'
import type { Json, Process, VNode } from '@nonchalant/core'
import { h, mount } from '@nonchalant/dom'
import { button, code, details, div, h2, h3, li, ol, p, pre, section, span, summary, ul } from '@nonchalant/dom/tags'
import { inspect, type Entry, type Inspector, type ProcNode, type TreeNode } from './record.ts'
import { describe, label, treeKey, uiProc, type Ui, type UiMsg } from './ui.ts'

export { describe, uiProc } from './ui.ts'
export type { Ui, UiMsg } from './ui.ts'

type UiProc = Process<Ui, UiMsg>

const TIMELINE_ROWS = 200

/** One VNode per immutable recorded object: a re-run list binding hands the sink the same rows. */
const cachedBy = <K extends object, A extends unknown[]>(build: (k: K, ...rest: A) => VNode): ((k: K, ...rest: A) => VNode) => {
  const rows = new WeakMap<K, VNode>()
  return (k, ...rest) => {
    let cached = rows.get(k)
    if (cached === undefined) {
      cached = build(k, ...rest)
      rows.set(k, cached)
    }
    return cached
  }
}

// ---------- values ----------

function JsonView(value: Json | null | undefined, depth = 0): VNode {
  if (value === undefined) return span({ class: 'nci-muted' }, 'no value')
  if (value === null || typeof value !== 'object') return span({ class: `nci-${value === null ? 'null' : typeof value}` }, JSON.stringify(value))
  const pairs: [string, Json][] = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value)
  const shown = pairs.slice(0, 100)
  return details({ open: depth < 2 },
    summary({}, Array.isArray(value) ? `Array(${pairs.length})` : `{${pairs.length} ${pairs.length === 1 ? 'key' : 'keys'}}`),
    ul({ class: 'nci-json' },
      ...shown.map(([k, v]) => li({}, span({ class: 'nci-key' }, k), ': ', JsonView(v, depth + 1))),
      pairs.length > shown.length ? li({ class: 'nci-muted' }, `… ${pairs.length - shown.length} more`) : null))
}

function Badges(node: ProcNode): VNode {
  return span({ class: 'nci-badges' },
    node.status !== 'running' ? span({ class: `nci-badge nci-${node.status}` }, node.status) : null,
    node.pending ? span({ class: 'nci-badge' }, 'pending') : null,
    node.stale ? span({ class: 'nci-badge' }, 'stale') : null,
    node.errored ? span({ class: 'nci-badge nci-crashed' }, 'error') : null)
}

// ---------- the process tree ----------

// the DOM half of treeKey: the one tab stop moves with focus
function onTreeKey(e: KeyboardEvent & { readonly currentTarget: HTMLUListElement }): void {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')]
  const at = items.indexOf(e.target as HTMLElement)
  const action = treeKey(e.key, at, items.length)
  if (action === null) return
  e.preventDefault()
  switch (action.type) {
    case 'focus': {
      const item = items[action.index]!
      for (const other of items) other.tabIndex = -1
      item.tabIndex = 0
      item.focus()
      break
    }
    case 'select':
      items[at]?.click()
      break
  }
}

function TreeRow(node: ProcNode, level: number, insp: Inspector, ui: UiProc): VNode {
  return li({
    key: node.id,
    role: 'treeitem',
    'aria-level': level,
    'aria-selected': () => String(ui().selected === node.id),
    // one tab stop: the selected item, or the first when none is
    tabindex: () => {
      const sel = ui().selected
      return sel === node.id || (sel === null && insp.tree()[0]?.node.id === node.id) ? 0 : -1
    },
    class: 'nci-item',
    onclick: () => ui.cast({ type: 'select', id: ui().selected === node.id ? null : node.id }),
  },
    span({ class: 'nci-name', style: `padding-inline-start: ${(level - 1) * 1.1}em` }, label(node)),
    span({ class: 'nci-muted' }, ` #${node.id}`),
    Badges(node))
}

function ProcessTree(insp: Inspector, ui: UiProc): VNode {
  const row = cachedBy(TreeRow)
  const flatten = (nodes: TreeNode[], level: number, out: VNode[]): VNode[] => {
    for (const t of nodes) {
      out.push(row(t.node, level, insp, ui))
      flatten(t.children, level + 1, out)
    }
    return out
  }
  return section({ class: 'nci-pane', 'aria-labelledby': 'nci-tree-h' },
    h3({ id: 'nci-tree-h' }, 'Processes'),
    ul({ role: 'tree', 'aria-labelledby': 'nci-tree-h', class: 'nci-tree', onkeydown: onTreeKey }, () => {
      const out = flatten(insp.tree(), 1, [])
      return out.length === 0 ? [li({ class: 'nci-muted', key: 'none' }, 'No processes yet.')] : out
    }),
    () => (ui().selected === null ? null : button({ type: 'button', onclick: () => ui.cast({ type: 'select', id: null }) }, 'Show all processes')))
}

// ---------- the timeline ----------

function TimelineRow(e: Entry, insp: Inspector, ui: UiProc): VNode {
  const node = insp.recording().procs[e.id]
  return li({ key: e.seq },
    button({
      type: 'button',
      class: `nci-entry nci-${e.type}`,
      'aria-pressed': () => String(ui().picked === e.seq),
      onclick: () => ui.cast({ type: 'pick', seq: ui().picked === e.seq ? null : e.seq }),
    },
      span({ class: 'nci-muted' }, `${e.seq} `),
      span({ class: 'nci-name' }, `${node === undefined ? '?' : label(node)}#${e.id} `),
      describe(e)))
}

function Timeline(insp: Inspector, ui: UiProc): VNode {
  const row = cachedBy(TimelineRow)
  return section({ class: 'nci-pane', 'aria-labelledby': 'nci-timeline-h' },
    h3({ id: 'nci-timeline-h' }, () => {
      const sel = ui().selected
      return sel === null ? 'Timeline' : `Timeline: #${sel} only`
    }),
    ol({ class: 'nci-timeline', reversed: true }, () => {
      const sel = ui().selected
      const out: VNode[] = []
      const events = insp.timeline()
      for (let i = events.length - 1; i >= 0 && out.length < TIMELINE_ROWS; i--) {
        const e = events[i]!
        if (sel === null || e.id === sel) out.push(row(e, insp, ui))
      }
      return out
    }))
}

// ---------- the detail pane ----------

// time travel: the picked event, its patch, and a process as it was just
// after it — the selected one, or the event's own
function PickedDetail(insp: Inspector, ui: UiProc, entry: Entry, selected: number | null): VNode {
  const id = selected ?? entry.id
  const node = insp.recording().procs[id]
  return div({},
    h3({ id: 'nci-detail-h' }, `After event ${entry.seq}`),
    p({}, code({}, describe(entry))),
    entry.type === 'yield'
      ? div({}, h3({}, 'Patch'), ol({ class: 'nci-ops' }, ...entry.ops.map((op) => li({}, pre({}, JSON.stringify(op))))))
      : null,
    h3({}, `State of ${node === undefined ? '?' : label(node)}#${id} at ${entry.seq}`),
    JsonView(insp.stateAt(id, entry.seq)),
    button({ type: 'button', onclick: () => ui.cast({ type: 'pick', seq: null }) }, 'Back to live'))
}

function LiveDetail(node: ProcNode | undefined): VNode {
  if (node === undefined) return div({}, h3({ id: 'nci-detail-h' }, 'State'), p({ class: 'nci-muted' }, 'Select a process or an event.'))
  return div({},
    h3({ id: 'nci-detail-h' }, `State of ${label(node)}#${node.id}`),
    JsonView(node.state))
}

function Detail(insp: Inspector, ui: UiProc): VNode {
  return section({ class: 'nci-pane', 'aria-labelledby': 'nci-detail-h', 'aria-live': 'polite' }, () => {
    const { selected, picked } = ui()
    const rec = insp.recording()
    const entry = picked === null ? undefined : rec.events.find((e) => e.seq === picked)
    if (entry !== undefined) return PickedDetail(insp, ui, entry, selected)
    return LiveDetail(selected === null ? undefined : rec.procs[selected])
  })
}

// ---------- the panel ----------

const CSS = `
.nci-root { color-scheme: light dark; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: Canvas; color: CanvasText; border-top: 1px solid GrayText; padding: 8px; box-sizing: border-box; }
.nci-root h2, .nci-root h3 { font-size: 12px; margin: 4px 0; }
.nci-bar { display: flex; gap: 8px; align-items: center; }
.nci-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 1.2fr); gap: 8px; }
@media (max-width: 720px) { .nci-grid { grid-template-columns: minmax(0, 1fr); } }
.nci-pane { min-width: 0; overflow: auto; max-height: 38vh; }
.nci-tree, .nci-timeline, .nci-json, .nci-ops { list-style: none; margin: 0; padding: 0; }
.nci-json { padding-inline-start: 1.1em; }
.nci-item { cursor: pointer; padding: 1px 4px; border-radius: 3px; }
.nci-item[aria-selected="true"] { background: Highlight; color: HighlightText; }
.nci-item:focus-visible, .nci-entry:focus-visible { outline: 2px solid Highlight; outline-offset: -2px; }
.nci-entry { all: unset; box-sizing: border-box; display: block; width: 100%; padding: 1px 4px; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-radius: 3px; }
.nci-entry[aria-pressed="true"] { background: Highlight; color: HighlightText; }
.nci-crash, .nci-crashed { color: #c62828; }
.nci-badge { border: 1px solid currentColor; border-radius: 3px; padding: 0 3px; margin-inline-start: 4px; font-size: 10px; }
.nci-muted { opacity: .65; }
.nci-string { color: #2e7d32; } .nci-number, .nci-boolean { color: #1565c0; }
@media (prefers-color-scheme: dark) { .nci-string { color: #81c784; } .nci-number, .nci-boolean { color: #64b5f6; } .nci-crash, .nci-crashed { color: #ef9a9a; } }
.nci-ops pre { margin: 0; white-space: pre-wrap; word-break: break-all; }
`

function Panel(insp: Inspector, ui: UiProc): VNode {
  return section({ class: 'nci-root', 'aria-label': 'Process inspector' },
    h('style', {}, CSS),
    div({ class: 'nci-bar' },
      h2({}, 'Inspector'),
      button({ type: 'button', onclick: () => insp.recording.cast({ type: 'clear' }) }, 'Clear timeline')),
    div({ class: 'nci-grid' },
      ProcessTree(insp, ui),
      Timeline(insp, ui),
      Detail(insp, ui)))
}

export interface MountedInspector extends Disposable {
  readonly inspector: Inspector
}

/**
 * Render the inspector panel into `el`. Starts an inspector unless one is
 * passed; disposing the panel disposes the inspector it started.
 */
export function mountInspector(el: Element, inspector?: Inspector): MountedInspector {
  const insp = inspector ?? inspect()
  const ui = insp.adopt(() => spawn(uiProc, undefined, { initial: { selected: null, picked: null } }))
  const view = insp.adopt(() => mount(el, Panel(insp, ui)))
  return {
    inspector: insp,
    [Symbol.dispose]: () => {
      view[Symbol.dispose]()
      ui[Symbol.dispose]()
      if (inspector === undefined) insp[Symbol.dispose]()
    },
  }
}
