// The panel's headless half: what is selected, how entries and processes are
// named, and what a key does in the process tree. No DOM here.

import type { Cast, Json, Self } from '@nonchalant/core'
import type { Entry, ProcNode } from './recording.ts'

// ---------- selection ----------

export interface Ui {
  /** Process whose events the timeline shows (null: all). */
  selected: number | null
  /** Timeline entry picked for time travel (null: live). */
  picked: number | null
}

export type UiMsg = Cast<{ type: 'select'; id: number | null }> | Cast<{ type: 'pick'; seq: number | null }>

export async function* uiProc(self: Self<UiMsg>): AsyncGenerator<Ui> {
  let ui: Ui = { selected: null, picked: null }
  for await (const msg of self) {
    switch (msg.type) {
      case 'select':
        if (msg.id === ui.selected) continue
        ui = { selected: msg.id, picked: null }
        break
      case 'pick':
        if (msg.seq === ui.picked) continue
        ui = { ...ui, picked: msg.seq }
        break
    }
    yield ui
  }
}

// ---------- text ----------

/** JSON on one line, cut to 80 characters. */
export const brief = (v: Json): string => {
  const s = JSON.stringify(v) ?? String(v)
  return s.length > 80 ? `${s.slice(0, 79)}…` : s
}

/** One line of plain text for a timeline entry. */
export function describe(e: Entry): string {
  switch (e.type) {
    case 'spawn': return `spawn${e.key === null ? '' : ` as ${e.key}`} ${brief(e.args)}`
    case 'cast': return `cast ${brief(e.msg)}`
    case 'call': return `call #${e.call} ${brief(e.msg)}`
    case 'reply': return `reply #${e.call} ${brief(e.value)}`
    case 'yield': return `yield ${e.ops.length} op${e.ops.length === 1 ? '' : 's'}`
    case 'crash': return `crash ${e.error}`
    case 'restart': return `restart ${e.attempt}`
    case 'exit': return `exit ${e.reason}`
  }
}

/** A process's name in the panel: its registry key, else its generator's name. */
export const label = (node: ProcNode): string => node.key ?? (node.name || 'anonymous')

// ---------- tree keys ----------

export type TreeAction = { type: 'focus'; index: number } | { type: 'select' }

/**
 * Roving focus over `count` treeitems, from the item at `at` (-1: none):
 * arrows, Home and End move focus, clamped to the ends; Enter and Space
 * select. Null: the key is not the tree's, and is left to the browser.
 */
export function treeKey(key: string, at: number, count: number): TreeAction | null {
  const to = (i: number): TreeAction | null => (count === 0 ? null : { type: 'focus', index: Math.max(0, Math.min(count - 1, i)) })
  switch (key) {
    case 'ArrowDown': return to(at + 1)
    case 'ArrowUp': return to(at - 1)
    case 'Home': return to(0)
    case 'End': return to(count - 1)
    case 'Enter':
    case ' ':
      return { type: 'select' }
    default:
      return null
  }
}
