// The views the report mounts. Rows have the js-framework-benchmark shape:
// a keyed <tr> with a class binding on the selection process, an id cell and
// a label cell.

import type { Process, VNode } from '@nonchalant/core'
import { a, p, tbody, td, tr } from '@nonchalant/dom/tags'
import type { SelectMsg, Selection } from '../examples/js-framework-benchmark/bench.ts'
import type { Chunks, ChunksMsg, ListMsg, Row, Table, TableMsg, Text, TextMsg } from './state.ts'

type Selected = Process<Selection, SelectMsg>

// ---------- components ----------

const rowClass = (selected: Selected, id: number) => (): string => (selected()[id] === true ? 'danger' : '')

/** The idiomatic keyed list: one thunk maps the whole array, so any change to it re-runs the map. */
export function List(rows: Process<Row[], ListMsg>, selected: Selected): VNode {
  return tbody({}, () =>
    rows().map((row) =>
      tr({ key: row.id, class: rowClass(selected, row.id) },
        td({}, String(row.id)),
        td({}, a({}, row.label)))))
}

/** Normalized: the list thunk reads only `order`; each label is its own binding on `byId`. */
export function NormalizedList(table: Process<Table, TableMsg>, selected: Selected): VNode {
  return tbody({}, () =>
    table().order.map((id) =>
      tr({ key: id, class: rowClass(selected, id) },
        td({}, String(id)),
        td({}, a({}, () => table().byId[id]?.label ?? '')))))
}

export function Stream(text: Process<Text, TextMsg>): VNode {
  return p({}, () => text().text)
}

/** Each chunk is its own text node: an append adds one node and writes nothing else. */
export function ChunkStream(chunks: Process<Chunks, ChunksMsg>): VNode {
  return p({}, () => chunks().chunks)
}
