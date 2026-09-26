// The update-path report behind `pnpm bench` and docs/performance.md. It
// times the whole path one yield takes: the reducer's immutable construction,
// reconcile, the graph waking readers, the bindings and DOM writes (under
// happy-dom), and the wire (encode, decode, applyPatch), for sparse edits,
// reorders, fresh snapshots and streams; then retained heap.
//
// A report, not a gate: these are times on one machine. The CI budgets assert
// precision (which bindings run, how many DOM writes), which does not vary
// by machine; throughput and latency do.
//
// "local e2e" is wall time from cast to the DOM settled: the message crosses
// the mailbox, the reducer runs, the yield reconciles and wakes readers, the
// effects drain. The window closes on setImmediate, which runs only after
// every microtask, so it holds the whole path and nothing after it. The
// "no DOM" column is the same process with nothing mounted: the core's share.

import { createRequire } from 'node:module'
import { cpus, platform, release } from 'node:os'
import { applyPatch, reconcile, spawn } from '@nonchalant/core'
import type { Json, Proc, Process, VNode } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { decodeHost, encode } from '@nonchalant/wire'
import { Window } from 'happy-dom'
import { selection, type SelectMsg, type Selection } from '../examples/js-framework-benchmark/bench.ts'
import { chunks, chunksStep, list, listStep, makeRows, makeTable, table, tableStep, text, textStep } from './state.ts'
import type { Chunks, ChunksMsg, ListMsg, Row, Table, TableMsg, Text, TextMsg } from './state.ts'
import { ChunkStream, List, NormalizedList, Stream } from './views.ts'

const WARMUP = 5
const MIN_SAMPLES = 7
const MAX_SAMPLES = 300
/** Stop sampling a case once its timed e2e runs add up to this much. */
const BUDGET_MS = 1_000

const window = new Window()
const doc = window.document as unknown as Document

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

type Selected = Process<Selection, SelectMsg>

/** The handle's face the harness drives; `Process<T, M>` has it for every concrete cast union. */
interface Handle<T, M> {
  (): T
  cast(msg: M): void
}

// ---------- cases ----------

interface Case<T extends Json, M> {
  name: string
  size: string
  proc: Proc<T, M, T>
  step: (state: T, msg: M) => T
  initial: () => T
  view: (handle: Process<T, M>, selected: Selected) => VNode
  /** Sample k's message, built inside the timed window: a fresh snapshot's JSON.parse is part of its cost. */
  op: (k: number) => M
  /** Put the state back after each sample, untimed, so every sample starts at the same size. */
  reset?: (prev: T) => M
  /** What the DOM must show for `state`; a mismatch aborts the report. */
  check: (root: Element, state: T) => boolean
}

const rowCount = (n: number): string => `${n.toLocaleString('en-US')} ${n === 1 ? 'row' : 'rows'}`

const rowsShown = (root: Element, rows: Row[]): boolean => {
  const trs = root.querySelectorAll('tr')
  return trs.length === rows.length && rows.every((r, i) => trs[i]!.textContent === `${r.id}${r.label}`)
}

const listCase = (name: string, n: number, op: (k: number) => ListMsg, reset?: (prev: Row[]) => ListMsg): Case<Row[], ListMsg> => ({
  name,
  size: rowCount(n),
  proc: list,
  step: listStep,
  initial: () => makeRows(n),
  view: List,
  op,
  ...(reset === undefined ? {} : { reset }),
  check: rowsShown,
})

// a server response for the same rows, and one with row n/2 changed
const bodies = (n: number): [string, string] => {
  const rows = makeRows(n)
  const changed = rows.with(n >> 1, { ...(rows[n >> 1] as Row), label: 'changed' })
  return [JSON.stringify(rows), JSON.stringify(changed)]
}

const listCases = (n: number): Case<Row[], ListMsg>[] => {
  const [same, changed] = bodies(n)
  return [
    listCase('sparse edit: one row', n, () => ({ type: 'edit', index: n >> 1 })),
    listCase('swap two rows', n, () => ({ type: 'swap', a: 1, b: n - 2 })),
    listCase('reverse', n, () => ({ type: 'reverse' })),
    listCase('fresh snapshot, equal data', n, () => ({ type: 'replace', rows: JSON.parse(same) as Row[] })),
    listCase('fresh snapshot, one row changed', n, (k) => ({ type: 'replace', rows: JSON.parse(k % 2 === 0 ? changed : same) as Row[] })),
    listCase('append one row', n, (k) => ({ type: 'append', row: { id: n + k, label: `row ${n + k}` } }), (prev) => ({ type: 'replace', rows: prev })),
  ]
}

const normalizedCase = (n: number): Case<Table, TableMsg> => ({
  name: 'sparse edit: one row, normalized',
  size: rowCount(n),
  proc: table,
  step: tableStep,
  initial: () => makeTable(n),
  view: NormalizedList,
  op: () => ({ type: 'edit', id: n >> 1 }),
  check: (root, t) => rowsShown(root, t.order.map((id) => t.byId[id] as Row)),
})

const textCase = (chars: number): Case<Text, TextMsg> => ({
  name: 'append a token to a text',
  size: `${chars.toLocaleString('en-US')} chars`,
  proc: text,
  step: textStep,
  initial: () => ({ text: 'x'.repeat(chars) }),
  view: Stream,
  op: () => ({ type: 'token', token: ' word' }),
  reset: (prev) => ({ type: 'replace', text: prev.text }),
  check: (root, t) => root.textContent === t.text,
})

const chunksCase = (chars: number): Case<Chunks, ChunksMsg> => ({
  name: 'append a token to a chunk list',
  size: `${chars.toLocaleString('en-US')} chars`,
  proc: chunks,
  step: chunksStep,
  initial: () => ({ chunks: Array.from({ length: chars / 5 }, () => 'xxxxx') }),
  view: ChunkStream,
  op: () => ({ type: 'token', token: ' word' }),
  reset: (prev) => ({ type: 'replace', chunks: prev.chunks }),
  check: (root, c) => root.textContent === c.chunks.join(''),
})

// ---------- measuring ----------

interface Sample {
  e2e: number
  construct: number
  reconcile: number
  wire: number
  ops: number
  bytes: number
}

const timed = <R>(fn: () => R): [ms: number, result: R] => {
  const t0 = performance.now()
  const r = fn()
  return [performance.now() - t0, r]
}

/** The same update off the live path: construction, the diff alone, and the wire's encode → decode → apply. */
function offPath<T extends Json, M>(c: Case<T, M>, prev: T, next: T, k: number): Omit<Sample, 'e2e'> {
  const [construct] = timed(() => c.step(prev, c.op(k)))
  const [diff, patch] = timed(() => reconcile(prev, next))
  const [wire, frame] = timed(() => {
    const frame = encode({ op: 'yield', ref: 'r1', patch: reconcile(prev, next) })
    const msg = decodeHost(frame)
    if (msg?.op !== 'yield') throw new Error('bench: the frame did not decode')
    applyPatch(prev, msg.patch)
    return frame
  })
  return { construct, reconcile: diff, wire, ops: patch.length, bytes: Buffer.byteLength(frame) }
}

/** Cast sample after sample into a fresh process, mounted or headless, until the budget is spent. */
async function drive<T extends Json, M>(c: Case<T, M>, mounted: boolean): Promise<Sample[]> {
  const init = c.initial()
  const proc = spawn(c.proc, init, { initial: init })
  const handle = proc as unknown as Handle<T, M>
  const selected = spawn(selection, undefined, { initial: {} })
  const root = doc.createElement('div')
  doc.body.appendChild(root)
  const view = mounted ? mount(root, c.view(proc, selected)) : undefined
  await settle()

  const samples: Sample[] = []
  let spent = 0
  for (let k = 0; k < WARMUP + MAX_SAMPLES && (samples.length < MIN_SAMPLES || spent < BUDGET_MS); k++) {
    const prev = handle()
    const t0 = performance.now()
    handle.cast(c.op(k))
    await settle()
    const e2e = performance.now() - t0
    const next = handle()
    if (next === prev) throw new Error(`bench: ${c.name} did not yield`)
    if (mounted && !c.check(root, next)) throw new Error(`bench: ${c.name} (${c.size}) left the DOM out of date`)
    if (k >= WARMUP) {
      spent += e2e
      samples.push({ e2e, ...(mounted ? offPath(c, prev, next, k) : { construct: 0, reconcile: 0, wire: 0, ops: 0, bytes: 0 }) })
    }
    if (c.reset !== undefined) {
      handle.cast(c.reset(prev))
      await settle()
    }
  }

  view?.[Symbol.dispose]()
  proc[Symbol.dispose]()
  selected[Symbol.dispose]()
  root.remove()
  return samples
}

const quantile = (xs: number[], q: number): number => {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] as number
}
const median = (xs: number[]): number => quantile(xs, 0.5)

const ms = (t: number): string =>
  t < 1 ? `${Math.round(t * 1000)} µs` : t < 10 ? `${t.toFixed(2)} ms` : t < 100 ? `${t.toFixed(1)} ms` : `${Math.round(t)} ms`

const bytes = (b: number): string =>
  b < 10_000 ? `${b} B` : b < 10_000_000 ? `${Math.round(b / 1000)} kB` : `${(b / 1e6).toFixed(0)} MB`

async function row<T extends Json, M>(c: Case<T, M>): Promise<string[]> {
  const headless = await drive(c, false)
  const full = await drive(c, true)
  const e2e = full.map((s) => s.e2e)
  const diff = median(full.map((s) => s.reconcile))
  return [
    c.name,
    c.size,
    ms(median(e2e)),
    ms(quantile(e2e, 0.95)),
    ms(median(headless.map((s) => s.e2e))),
    ms(median(full.map((s) => s.construct))),
    ms(diff),
    `${Math.round((100 * diff) / median(e2e))}%`,
    ms(median(full.map((s) => s.wire))),
    String(median(full.map((s) => s.ops))),
    bytes(median(full.map((s) => s.bytes))),
  ]
}

// ---------- streams, whole ----------

/** Stream `count` messages into one mounted process with no resets: total wall time, and the wire bytes the patches would carry. */
async function stream<T extends Json, M>(c: Case<T, M>, count: number): Promise<[total: number, wire: number]> {
  const init = c.initial()
  const proc = spawn(c.proc, init, { initial: init })
  const handle = proc as unknown as Handle<T, M>
  const selected = spawn(selection, undefined, { initial: {} })
  const root = doc.createElement('div')
  doc.body.appendChild(root)
  const view = mount(root, c.view(proc, selected))
  await settle()
  let total = 0
  let wire = 0
  for (let k = 0; k < count; k++) {
    const prev = handle()
    const t0 = performance.now()
    handle.cast(c.op(k))
    await settle()
    total += performance.now() - t0
    wire += Buffer.byteLength(encode({ op: 'yield', ref: 'r1', patch: reconcile(prev, handle()) }))
  }
  if (!c.check(root, handle())) throw new Error(`bench: stream ${c.name} left the DOM out of date`)
  view[Symbol.dispose]()
  proc[Symbol.dispose]()
  selected[Symbol.dispose]()
  root.remove()
  return [total, wire]
}

// ---------- memory ----------

const gc = (globalThis as { gc?: (opts?: { execution: 'async' }) => Promise<void> | void }).gc

// two async passes also reclaim what the first one's finalizers released
// (plain gc() can false-retain under V8's conservative stack scanning)
async function heap(): Promise<number> {
  for (let i = 0; i < 5; i++) await settle()
  await gc?.({ execution: 'async' })
  await gc?.({ execution: 'async' })
  return process.memoryUsage().heapUsed
}

/** Garbage elsewhere can only inflate a trial, never deflate it, so the least of three is the honest one. */
async function least(trial: () => Promise<number>): Promise<number> {
  let best = Number.POSITIVE_INFINITY
  for (let t = 0; t < 3; t++) best = Math.min(best, await trial())
  return best
}

/** Heap per row on top of the rows themselves: the process and the mounted keyed list. */
async function listHeap(n: number): Promise<number> {
  const rows = makeRows(n)
  const before = await heap()
  const proc = spawn(list, rows, { initial: rows })
  const selected = spawn(selection, undefined, { initial: {} })
  const root = doc.createElement('div')
  doc.body.appendChild(root)
  const view = mount(root, List(proc, selected))
  const after = await heap()
  if (!rowsShown(root, rows)) throw new Error('bench: the heap trial did not mount')
  view[Symbol.dispose]()
  proc[Symbol.dispose]()
  selected[Symbol.dispose]()
  root.remove()
  return (after - before) / n
}

/** The same rows built with DOM calls alone: what the DOM costs without the library. */
async function domHeap(n: number): Promise<number> {
  const rows = makeRows(n)
  const before = await heap()
  const root = doc.createElement('div')
  doc.body.appendChild(root)
  const body = doc.createElement('tbody')
  for (const r of rows) {
    const tr = doc.createElement('tr')
    tr.className = ''
    const id = doc.createElement('td')
    id.textContent = String(r.id)
    const label = doc.createElement('td')
    const a = doc.createElement('a')
    a.textContent = r.label
    label.appendChild(a)
    tr.append(id, label)
    body.appendChild(tr)
  }
  root.appendChild(body)
  const after = await heap()
  if (!rowsShown(root, rows)) throw new Error('bench: the hand-built rows are wrong')
  root.remove()
  return (after - before) / n
}

async function dataHeap(n: number): Promise<number> {
  const before = await heap()
  const rows = makeRows(n)
  const after = await heap()
  if (rows.length !== n) throw new Error('unreachable')
  return (after - before) / n
}

async function processHeap(count: number): Promise<number> {
  const before = await heap()
  const procs: Process<Text, TextMsg>[] = []
  for (let i = 0; i < count; i++) procs.push(spawn(text, { text: '' }, { initial: { text: '' } }))
  const after = await heap()
  for (const p of procs) p[Symbol.dispose]()
  return (after - before) / count
}

// ---------- the report ----------

// Markdown rows, printed as each finishes, so the output pastes into docs/performance.md
const line = (cells: string[]): void => console.log(`| ${cells.join(' | ')} |`)
const head = (cells: string[]): void => {
  console.log()
  line(cells)
  line(cells.map(() => '---'))
}

const happyDom = (createRequire(import.meta.url)('happy-dom/package.json') as { version: string }).version
console.log(`Node ${process.version}, ${cpus()[0]?.model.trim() ?? 'unknown CPU'}, ${platform()} ${release()}, happy-dom ${happyDom}`)

head(['case', 'size', 'local e2e median', 'p95', 'no DOM', 'construct', 'reconcile', 'reconcile share', 'wire', 'ops', 'patch bytes'])
line(await row(listCases(1)[0]!))
for (const n of [1_000, 10_000]) {
  for (const c of listCases(n)) line(await row(c))
  line(await row(normalizedCase(n)))
}
for (const chars of [10_000, 100_000]) line(await row(textCase(chars)))
for (const chars of [10_000, 100_000]) line(await row(chunksCase(chars)))

head(['stream', 'total local e2e', 'total wire bytes'])
for (const n of [500, 1_000]) {
  const [total, wire] = await stream(listCase('append', 0, (k) => ({ type: 'append', row: { id: k, label: `row ${k}` } })), n)
  line([`${n.toLocaleString('en-US')} rows appended one at a time, from empty`, ms(total), bytes(wire)])
}
for (const n of [2_000, 5_000]) {
  const [total, wire] = await stream(textCase(0), n)
  line([`${n.toLocaleString('en-US')} five-char tokens streamed into one string`, ms(total), bytes(wire)])
}
for (const n of [2_000, 5_000]) {
  const [total, wire] = await stream(chunksCase(0), n)
  line([`${n.toLocaleString('en-US')} five-char tokens streamed into a chunk list`, ms(total), bytes(wire)])
}

if (gc === undefined) console.log('\nmemory: skipped (run with --expose-gc, as `pnpm bench` does)')
else {
  const n = 10_000
  head(['memory (least of 3 trials)', 'bytes'])
  line(['10,000 rows as plain data, per row', String(Math.round(await least(() => dataHeap(n))))])
  const dom = await least(() => domHeap(n))
  const mounted = await least(() => listHeap(n))
  line(['the same rows built with plain DOM calls (happy-dom), per row', String(Math.round(dom))])
  line(['a process holding the rows plus the mounted keyed list, per row', String(Math.round(mounted))])
  line(['of which the library (bindings, vnodes, bookkeeping), per row', String(Math.round(mounted - dom))])
  line(['an idle process (10,000 spawned), each', String(Math.round(await least(() => processHeap(n))))])
}

await window.happyDOM.close()
