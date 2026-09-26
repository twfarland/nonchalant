// The state the update-path report (run.ts) drives: a keyed row list, the
// same rows normalized into order + byId, and a growing text. Each process is
// a reducer, so the harness can time the pure step (the user's immutable
// construction) apart from everything downstream of the yield.

import { reducer } from '@nonchalant/core'
import type { Cast, Proc } from '@nonchalant/core'

export type Row = { id: number; label: string }

export const makeRows = (n: number, from = 0): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: from + i, label: `row ${from + i}` }))

// an edit that can be repeated forever without the label growing
const toggle = (label: string): string => (label.endsWith(' !') ? label.slice(0, -2) : `${label} !`)

// ---------- a keyed list ----------

export type ListMsg =
  | Cast<{ type: 'edit'; index: number }>
  | Cast<{ type: 'swap'; a: number; b: number }>
  | Cast<{ type: 'reverse' }>
  | Cast<{ type: 'append'; row: Row }>
  | Cast<{ type: 'replace'; rows: Row[] }>

export function listStep(rows: Row[], msg: ListMsg): Row[] {
  switch (msg.type) {
    case 'edit': {
      const row = rows[msg.index] as Row
      return rows.with(msg.index, { ...row, label: toggle(row.label) })
    }
    case 'swap': {
      const next = [...rows]
      next[msg.a] = rows[msg.b] as Row
      next[msg.b] = rows[msg.a] as Row
      return next
    }
    case 'reverse':
      return rows.toReversed()
    case 'append':
      return [...rows, msg.row]
    case 'replace':
      return msg.rows
  }
}

export const list: Proc<Row[], ListMsg, Row[]> = reducer((rows: Row[]) => rows, listStep)

// ---------- the same rows, normalized ----------

export type Table = { order: number[]; byId: { [id: string]: Row } }

export type TableMsg =
  | Cast<{ type: 'edit'; id: number }>
  | Cast<{ type: 'replace'; table: Table }>

export const makeTable = (n: number): Table => {
  const rows = makeRows(n)
  return { order: rows.map((r) => r.id), byId: Object.fromEntries(rows.map((r) => [r.id, r])) }
}

export function tableStep(table: Table, msg: TableMsg): Table {
  switch (msg.type) {
    case 'edit': {
      const row = table.byId[msg.id] as Row
      return { ...table, byId: { ...table.byId, [msg.id]: { ...row, label: toggle(row.label) } } }
    }
    case 'replace':
      return msg.table
  }
}

export const table: Proc<Table, TableMsg, Table> = reducer((t: Table) => t, tableStep)

// ---------- a streamed text ----------

export type Text = { text: string }

export type TextMsg =
  | Cast<{ type: 'token'; token: string }>
  | Cast<{ type: 'replace'; text: string }>

export function textStep(state: Text, msg: TextMsg): Text {
  switch (msg.type) {
    case 'token':
      return { text: state.text + msg.token }
    case 'replace':
      return { text: msg.text }
  }
}

export const text: Proc<Text, TextMsg, Text> = reducer((t: Text) => t, textStep)

// ---------- the same stream, kept as chunks ----------

export type Chunks = { chunks: string[] }

export type ChunksMsg =
  | Cast<{ type: 'token'; token: string }>
  | Cast<{ type: 'replace'; chunks: string[] }>

export function chunksStep(state: Chunks, msg: ChunksMsg): Chunks {
  switch (msg.type) {
    case 'token':
      return { chunks: [...state.chunks, msg.token] }
    case 'replace':
      return { chunks: msg.chunks }
  }
}

export const chunks: Proc<Chunks, ChunksMsg, Chunks> = reducer((c: Chunks) => c, chunksStep)
