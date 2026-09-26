// An element's static children, patched position by position. Text and
// vnodes render in place; every other slot becomes a hole: a marker plus a
// region, fed by a binding (thunk or process), a promise, or an async iterable.

import { binding, rebind, unbind, untracked } from '@nonchalant/core'
import type { Binding, Slot } from '@nonchalant/core'
import { patchElement, renderElement, disposeElItem } from './element.ts'
import type { ElItem } from './element.ts'
import { createRegion, drive, isAsyncIterable, isPromise, isVNode } from './region.ts'
import type { Region } from './region.ts'
import { warn } from './report.ts'

type Disposer = () => void

export type ChildRec =
  | { kind: 'empty' }
  | { kind: 'text'; node: Text; value: string; slot: Slot }
  | { kind: 'el'; item: ElItem; slot: Slot }
  // a function slot's stop is its binding (rebindable); promise/iterable holes get a disposer
  | { kind: 'hole'; slot: Slot; marker: Comment; region: Region; stop: Disposer | Binding }

const recFirstNode = (rec: ChildRec): ChildNode | null =>
  rec.kind === 'text' ? rec.node : rec.kind === 'el' ? rec.item.el : rec.kind === 'hole' ? rec.region.first() : null

const isEmptySlot = (slot: Slot): slot is null | undefined | boolean =>
  slot === null || slot === undefined || typeof slot === 'boolean'

function createChildRec(
  doc: Document,
  parent: Element,
  slot: Slot,
  ns: string,
  anchor: ChildNode | null,
): ChildRec {
  if (isEmptySlot(slot)) return { kind: 'empty' }
  if (typeof slot === 'string' || typeof slot === 'number') {
    const value = String(slot)
    const node = doc.createTextNode(value)
    parent.insertBefore(node, anchor)
    return { kind: 'text', node, value, slot }
  }
  if (isVNode(slot)) {
    const item = renderElement(doc, slot, ns)
    parent.insertBefore(item.el, anchor)
    return { kind: 'el', item, slot }
  }
  const marker = doc.createComment('')
  parent.insertBefore(marker, anchor)
  const region = createRegion(doc, parent, marker, ns)
  return { kind: 'hole', slot, marker, region, stop: feed(region, slot) }
}

/** Start whatever drives a hole's region; the result stops it. */
function feed(region: Region, slot: Slot): Disposer | Binding {
  if (typeof slot === 'function') return binding(drive(region, slot, 'slot binding'))
  if (isPromise(slot)) return feedPromise(region, slot)
  if (isAsyncIterable(slot)) return feedIterable(region, slot)
  region.apply(slot) // unsupported: reports and renders nothing
  return () => {}
}

function feedPromise(region: Region, slot: Promise<unknown>): Disposer {
  let dead = false
  slot.then(
    (v) => {
      if (!dead) untracked(() => region.apply(v))
    },
    (e) => {
      if (!dead) warn('slot promise rejected; keeping content', e)
    },
  )
  return () => {
    dead = true
  }
}

function feedIterable(region: Region, slot: AsyncIterable<unknown>): Disposer {
  let dead = false
  const it = slot[Symbol.asyncIterator]()
  void (async () => {
    try {
      while (true) {
        const r = await it.next()
        if (dead || r.done === true) return
        untracked(() => region.apply(r.value))
      }
    } catch (e) {
      if (!dead) warn('slot iterable failed; keeping content', e)
    }
  })()
  return () => {
    dead = true
    // a silent iterator never resolves next(); closing it releases the
    // subscription it holds (a process iterator's effect, a generator's finally)
    void Promise.resolve(it.return?.()).catch(() => {})
  }
}

export function disposeChildRec(rec: ChildRec): void {
  if (rec.kind === 'el') disposeElItem(rec.item)
  else if (rec.kind === 'hole') {
    const stop = rec.stop
    if (typeof stop === 'function') stop()
    else unbind(stop)
    rec.region.destroy()
  }
}

function removeChildRec(rec: ChildRec): void {
  disposeChildRec(rec)
  ;(rec.kind === 'hole' ? rec.marker : recFirstNode(rec))?.remove()
}

export function patchChildren(doc: Document, item: ElItem, nextChildren: readonly Slot[]): void {
  const flat = nextChildren.flat(Infinity as 1) as Slot[]
  const olds = item.children
  const next: ChildRec[] = []
  for (let i = 0; i < flat.length; i++) {
    const slot = flat[i] as Slot
    const old = olds[i]
    next.push(old !== undefined ? patchChildRec(doc, item, old, slot) : createChildRec(doc, item.el, slot, item.childNs, null))
  }
  for (let i = flat.length; i < olds.length; i++) removeChildRec(olds[i] as ChildRec)
  item.children = next
}

function patchChildRec(doc: Document, parent: ElItem, old: ChildRec, slot: Slot): ChildRec {
  if (old.kind !== 'empty' && old.slot === slot) return old // same reference: binding/subtree untouched
  if (old.kind === 'empty' && isEmptySlot(slot)) return old
  if (old.kind === 'text' && (typeof slot === 'string' || typeof slot === 'number')) {
    const value = String(slot)
    if (value !== old.value) {
      old.node.data = value
      old.value = value
    }
    old.slot = slot
    return old
  }
  if (old.kind === 'el' && isVNode(slot)) {
    if (patchElement(doc, old.item, slot)) {
      old.slot = slot
      return old
    }
  }
  if (old.kind === 'hole' && typeof old.slot === 'function' && typeof slot === 'function') {
    // a fresh closure for the same hole: swap it into the hole's binding; the region diffs, keeping its DOM
    rebind(old.stop as Binding, drive(old.region, slot, 'slot binding'))
    old.slot = slot
    return old
  }
  // shape changed: replace in place
  const anchor = recFirstNode(old) ?? nextAnchor(parent, old)
  const fresh = createChildRec(doc, parent.el, slot, parent.childNs, anchor)
  removeChildRec(old)
  return fresh
}

const nextAnchor = (parent: ElItem, from: ChildRec): ChildNode | null => {
  const idx = parent.children.indexOf(from)
  for (let i = idx + 1; i < parent.children.length; i++) {
    const node = recFirstNode(parent.children[i] as ChildRec)
    if (node !== null) return node
  }
  return null
}
