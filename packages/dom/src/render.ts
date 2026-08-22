// The DOM sink. Interprets VNode trees (plain data) into real nodes:
// createElement / createTextNode / setAttribute only — no string is ever
// parsed as markup, so markup injection is impossible by construction.
//
// Granularity: static structure renders once; every dynamic slot (a thunk or a
// process placed in the tree) becomes a marker-anchored *region* driven by one
// effect. The effect's tracked read decides when the region wakes; the region
// then reconciles its rendered children against the new value — the one honest
// localized keyed diff: reference-equal vnodes are
// skipped, matched keys patch in place (`key: 0` is a key — presence, not
// truthiness), moved keys move DOM nodes, absent keys dispose (deferred through
// the `exit` hook when present).
//
// Per-slot pending/error: a promise slot holds only its own region (empty until
// it settles; rejection logs and stays empty); a throwing binding logs and
// keeps its previous content. Nothing above re-renders, nothing below unmounts.
//
// Item construction inside a region runs `untracked` so nested bindings become
// independent effects (owned by the item's disposer, not the region's effect —
// a region re-run must not tear down the bindings of items it reuses).

import { effect, untracked } from '@nonchalant/core'
import type { ProcessBase, Sink, Slot, VNode } from '@nonchalant/core'

const SVG_NS = 'http://www.w3.org/2000/svg'
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

const SPECIAL_ATTRS = new Set(['key', 'exit', 'ns'])
// interactive state lives on the property, not the attribute
const PROP_ATTRS = new Set(['value', 'checked', 'selected'])

type Disposer = () => void

const isVNode = (v: unknown): v is VNode =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  typeof (v as { tag?: unknown }).tag === 'string' &&
  typeof (v as { attrs?: unknown }).attrs === 'object' &&
  Array.isArray((v as { children?: unknown }).children)

const isAsyncIterable = (v: unknown): v is AsyncIterable<unknown> =>
  typeof v === 'object' && v !== null && Symbol.asyncIterator in v

const isPromise = (v: unknown): v is Promise<unknown> =>
  typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function'

const warn = (what: string, e?: unknown): void => {
  console.error(`nonchalant/dom: ${what}`, e)
}

// ---------- elements ----------

interface ElItem {
  el: Element
  vnode: VNode
  /** namespace the element's children render in */
  childNs: string
  attrEffects: Map<string, Disposer>
  listeners: Map<string, [type: string, fn: EventListener]>
  children: ChildRec[]
  key: unknown
  hasKey: boolean
  exit: ((el: Element) => unknown) | undefined
}

type ChildRec =
  | { kind: 'empty' }
  | { kind: 'text'; node: Text; value: string; slot: Slot }
  | { kind: 'el'; item: ElItem; slot: Slot }
  | { kind: 'hole'; slot: Slot; marker: Comment; region: Region; dispose: Disposer }

const recFirstNode = (rec: ChildRec): ChildNode | null => {
  switch (rec.kind) {
    case 'empty':
      return null
    case 'text':
      return rec.node
    case 'el':
      return rec.item.el
    case 'hole':
      return rec.region.first()
  }
}

function elementNs(tag: string, explicit: string | undefined, parentNs: string): string {
  if (explicit !== undefined) return explicit
  if (tag === 'svg') return SVG_NS
  if (tag === 'math') return MATHML_NS
  return parentNs
}

function renderElement(doc: Document, vnode: VNode, parentNs: string): ElItem {
  const ns = elementNs(vnode.tag, vnode.ns, parentNs)
  const el = ns === XHTML_NS ? doc.createElement(vnode.tag) : doc.createElementNS(ns, vnode.tag)
  const attrs = vnode.attrs
  const item: ElItem = {
    el,
    vnode,
    childNs: vnode.tag === 'foreignObject' ? XHTML_NS : ns,
    attrEffects: new Map(),
    listeners: new Map(),
    children: [],
    key: attrs['key'],
    hasKey: 'key' in attrs,
    exit: typeof attrs['exit'] === 'function' ? (attrs['exit'] as (el: Element) => unknown) : undefined,
  }
  for (const name of Object.keys(attrs)) applyAttr(item, name, attrs[name])
  for (const slot of flattenStatic(vnode.children)) {
    item.children.push(createChildRec(doc, el, slot, item.childNs, null))
  }
  return item
}

function setAttrValue(el: Element, name: string, v: unknown): void {
  if (PROP_ATTRS.has(name) && name in el) {
    ;(el as unknown as Record<string, unknown>)[name] = v
    return
  }
  if (v === null || v === undefined || v === false) el.removeAttribute(name)
  else if (v === true) el.setAttribute(name, '')
  else el.setAttribute(name, String(v))
}

function cleanupAttr(item: ElItem, name: string): void {
  const listener = item.listeners.get(name)
  if (listener !== undefined) {
    item.el.removeEventListener(listener[0], listener[1])
    item.listeners.delete(name)
    return
  }
  const stop = item.attrEffects.get(name)
  if (stop !== undefined) {
    stop()
    item.attrEffects.delete(name)
  }
  setAttrValue(item.el, name, null)
}

function applyAttr(item: ElItem, name: string, v: unknown): void {
  if (SPECIAL_ATTRS.has(name)) return
  if (typeof v === 'function' && name.startsWith('on')) {
    const type = name.slice(2)
    const fn = v as EventListener
    item.el.addEventListener(type, fn)
    item.listeners.set(name, [type, fn])
    return
  }
  if (typeof v === 'function') {
    // reactive binding: thunk or process — same shape, same handling
    const read = v as () => unknown
    const stop = effect(() => {
      let value: unknown
      try {
        value = read()
      } catch (e) {
        warn(`attribute binding "${name}" failed; keeping previous value`, e)
        return
      }
      setAttrValue(item.el, name, value)
    })
    item.attrEffects.set(name, stop)
    return
  }
  setAttrValue(item.el, name, v)
}

function disposeElItem(item: ElItem): void {
  for (const stop of item.attrEffects.values()) stop()
  item.attrEffects.clear()
  for (const [type, fn] of item.listeners.values()) item.el.removeEventListener(type, fn)
  item.listeners.clear()
  for (const rec of item.children) disposeChildRec(rec)
  item.children = []
}

// ---------- static children ----------

function flattenStatic(children: readonly Slot[]): Slot[] {
  const out: Slot[] = []
  const walk = (slots: readonly Slot[]): void => {
    for (const s of slots) {
      if (Array.isArray(s)) walk(s)
      else out.push(s)
    }
  }
  walk(children)
  return out
}

function createChildRec(
  doc: Document,
  parent: Element,
  slot: Slot,
  ns: string,
  anchor: ChildNode | null,
): ChildRec {
  if (slot === null || slot === undefined || typeof slot === 'boolean') return { kind: 'empty' }
  if (typeof slot === 'string' || typeof slot === 'number') {
    const value = String(slot)
    const node = doc.createTextNode(value)
    parent.insertBefore(node, anchor)
    return { kind: 'text', node, value, slot }
  }
  if (typeof slot === 'function') {
    const marker = doc.createComment('')
    parent.insertBefore(marker, anchor)
    const region = createRegion(doc, parent, marker, ns)
    const stop = effect(() => {
      let v: unknown
      try {
        v = (slot as () => unknown)()
      } catch (e) {
        warn('slot binding threw; keeping previous content', e)
        return
      }
      untracked(() => region.apply(v))
    })
    return {
      kind: 'hole',
      slot,
      marker,
      region,
      dispose: () => {
        stop()
        region.destroy()
      },
    }
  }
  if (isPromise(slot)) {
    const marker = doc.createComment('')
    parent.insertBefore(marker, anchor)
    const region = createRegion(doc, parent, marker, ns)
    let dead = false
    slot.then(
      (v) => {
        if (!dead) untracked(() => region.apply(v as Slot))
      },
      (e) => {
        if (!dead) warn('slot promise rejected; slot stays empty', e)
      },
    )
    return {
      kind: 'hole',
      slot,
      marker,
      region,
      dispose: () => {
        dead = true
        region.destroy()
      },
    }
  }
  if (isAsyncIterable(slot)) {
    const marker = doc.createComment('')
    parent.insertBefore(marker, anchor)
    const region = createRegion(doc, parent, marker, ns)
    let dead = false
    const it = slot[Symbol.asyncIterator]()
    void (async () => {
      try {
        while (true) {
          const r = await it.next()
          if (dead || r.done === true) return
          untracked(() => region.apply(r.value as Slot))
        }
      } catch (e) {
        if (!dead) warn('slot iterable failed; keeping content', e)
      }
    })()
    return {
      kind: 'hole',
      slot,
      marker,
      region,
      dispose: () => {
        dead = true
        // a silent iterator never resolves next(); closing it releases the
        // subscription it holds (a process iterator's effect, a generator's finally)
        void Promise.resolve(it.return?.()).catch(() => {})
        region.destroy()
      },
    }
  }
  if (isVNode(slot)) {
    const item = renderElement(doc, slot, ns)
    parent.insertBefore(item.el, anchor)
    return { kind: 'el', item, slot }
  }
  warn(`unsupported slot value ${String(slot)}; rendering nothing`)
  return { kind: 'empty' }
}

function disposeChildRec(rec: ChildRec): void {
  if (rec.kind === 'el') disposeElItem(rec.item)
  else if (rec.kind === 'hole') rec.dispose()
}

function removeChildRec(rec: ChildRec): void {
  disposeChildRec(rec)
  if (rec.kind === 'text') rec.node.remove()
  else if (rec.kind === 'el') rec.item.el.remove()
  else if (rec.kind === 'hole') rec.marker.remove()
}

// ---------- patching (same-tag element update in place) ----------

/** Returns false when the element cannot be patched (tag/ns change) and must be replaced. */
function patchElement(doc: Document, item: ElItem, next: VNode): boolean {
  if (item.vnode === next) return true // reference-equal: skipped entirely
  // same tag under the same parent infers the same namespace; only an explicit ns can flip it
  if (next.tag !== item.vnode.tag || (next.ns !== undefined && next.ns !== item.el.namespaceURI))
    return false
  const oldAttrs = item.vnode.attrs
  const newAttrs = next.attrs
  for (const name of Object.keys(oldAttrs)) {
    if (!(name in newAttrs) && !SPECIAL_ATTRS.has(name)) cleanupAttr(item, name)
  }
  item.key = newAttrs['key']
  item.hasKey = 'key' in newAttrs
  item.exit = typeof newAttrs['exit'] === 'function' ? (newAttrs['exit'] as (el: Element) => unknown) : undefined
  for (const name of Object.keys(newAttrs)) {
    if (SPECIAL_ATTRS.has(name)) continue
    const nv = newAttrs[name]
    if (name in oldAttrs && oldAttrs[name] === nv) continue // unchanged (incl. same fn reference)
    if (name in oldAttrs) cleanupAttr(item, name)
    applyAttr(item, name, nv)
  }
  patchChildren(doc, item, next.children)
  item.vnode = next
  return true
}

function patchChildren(doc: Document, item: ElItem, nextChildren: readonly Slot[]): void {
  const flat = flattenStatic(nextChildren)
  const olds = item.children
  const next: ChildRec[] = []
  for (let i = 0; i < flat.length; i++) {
    const slot = flat[i] as Slot
    const old = olds[i]
    if (old !== undefined) {
      next.push(patchChildRec(doc, item, old, slot))
    } else {
      next.push(createChildRec(doc, item.el, slot, item.childNs, null))
    }
  }
  for (let i = flat.length; i < olds.length; i++) removeChildRec(olds[i] as ChildRec)
  item.children = next
}

function patchChildRec(doc: Document, parent: ElItem, old: ChildRec, slot: Slot): ChildRec {
  if (old.kind !== 'empty' && old.slot === slot) return old // same reference: binding/subtree untouched
  if (old.kind === 'empty' && (slot === null || slot === undefined || typeof slot === 'boolean')) return old
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

// ---------- regions (dynamic slots: the one honest keyed diff) ----------

type RegionItem =
  | { kind: 'text'; node: Text; value: string }
  | { kind: 'el'; item: ElItem }

interface Region {
  apply(value: unknown): void
  /** Immediate teardown (no exit transitions); the marker is the caller's. */
  destroy(): void
  first(): ChildNode
}

const itemNode = (it: RegionItem): ChildNode => (it.kind === 'text' ? it.node : it.item.el)

function createRegion(doc: Document, parent: Node, marker: Comment, ns: string): Region {
  let items: RegionItem[] = []

  const flattenValue = (v: unknown, out: (string | VNode)[]): void => {
    if (v === null || v === undefined || typeof v === 'boolean') return
    if (typeof v === 'string') out.push(v)
    else if (typeof v === 'number') out.push(String(v))
    else if (Array.isArray(v)) for (const x of v) flattenValue(x, out)
    else if (isVNode(v)) out.push(v)
    else warn(`unsupported value in dynamic slot (${typeof v}); skipping`)
  }

  const removeItem = (it: RegionItem): void => {
    if (it.kind === 'text') {
      it.node.remove()
      return
    }
    const { item } = it
    disposeElItem(item)
    if (item.exit !== undefined) {
      let res: unknown
      try {
        res = item.exit(item.el)
      } catch (e) {
        warn('exit hook threw; removing immediately', e)
        item.el.remove()
        return
      }
      void Promise.resolve(res).then(
        () => item.el.remove(),
        () => item.el.remove(),
      )
      return
    }
    item.el.remove()
  }

  // a promise value keeps current content until it settles (lazy routes: a
  // thunk returning import(...).then(...)); a newer value supersedes it
  let pendingToken = 0
  let destroyed = false

  const apply = (value: unknown): void => {
    const token = ++pendingToken
    if (isPromise(value)) {
      value.then(
        (v) => {
          if (!destroyed && token === pendingToken) applyNow(v)
        },
        (e) => {
          if (!destroyed && token === pendingToken) warn('slot promise rejected; keeping content', e)
        },
      )
      return
    }
    applyNow(value)
  }

  const applyNow = (value: unknown): void => {
    const flat: (string | VNode)[] = []
    flattenValue(value, flat)

    const olds = items
    const byKey = new Map<unknown, RegionItem & { kind: 'el' }>()
    for (const it of olds) {
      if (it.kind === 'el' && it.item.hasKey) byKey.set(it.item.key, it as RegionItem & { kind: 'el' })
    }
    const used = new Set<RegionItem>()
    let oldIdx = 0
    const takePositional = (): RegionItem | undefined => {
      while (oldIdx < olds.length && used.has(olds[oldIdx] as RegionItem)) oldIdx++
      return olds[oldIdx]
    }

    const next: RegionItem[] = []
    for (const r of flat) {
      if (typeof r === 'string') {
        const cand = takePositional()
        if (cand !== undefined && cand.kind === 'text') {
          used.add(cand)
          oldIdx++
          if (cand.value !== r) {
            cand.node.data = r
            cand.value = r
          }
          next.push(cand)
        } else {
          next.push({ kind: 'text', node: doc.createTextNode(r), value: r })
        }
        continue
      }
      // vnode
      const hasKey = 'key' in r.attrs
      let reused: (RegionItem & { kind: 'el' }) | undefined
      if (hasKey) {
        const cand = byKey.get(r.attrs['key'])
        if (cand !== undefined && !used.has(cand) && cand.item.vnode.tag === r.tag) reused = cand
      } else {
        const cand = takePositional()
        if (cand !== undefined && cand.kind === 'el' && !cand.item.hasKey && cand.item.vnode.tag === r.tag) {
          reused = cand as RegionItem & { kind: 'el' }
          oldIdx++
        }
      }
      if (reused !== undefined) {
        used.add(reused)
        if (!patchElement(doc, reused.item, r)) {
          // tag matched but ns flipped — rebuild
          used.delete(reused)
          reused = undefined
        }
      }
      if (reused !== undefined) next.push(reused)
      else next.push({ kind: 'el', item: renderElement(doc, r, ns) })
    }

    for (const it of olds) if (!used.has(it)) removeItem(it)

    // minimal-move ordering pass: walk backwards, keep nodes already in place
    let anchor: ChildNode = marker
    for (let i = next.length - 1; i >= 0; i--) {
      const node = itemNode(next[i] as RegionItem)
      if (node.nextSibling !== anchor || node.parentNode === null) parent.insertBefore(node, anchor)
      anchor = node
    }
    items = next
  }

  return {
    apply,
    destroy: () => {
      destroyed = true
      for (const it of items) {
        if (it.kind === 'el') disposeElItem(it.item)
        itemNode(it).remove()
      }
      items = []
    },
    first: () => (items.length > 0 ? itemNode(items[0] as RegionItem) : marker),
  }
}

// ---------- mount ----------

export type View = VNode | ProcessBase<VNode | undefined> | (() => VNode | null | undefined)

/** Attach a view (a VNode, a thunk, or a view process) to a container element. */
export function mount(container: Element, view: View): Disposable {
  const doc = container.ownerDocument
  const marker = doc.createComment('')
  container.appendChild(marker)
  const ns = container.namespaceURI ?? XHTML_NS
  const region = createRegion(doc, container, marker, ns)
  let stop: Disposer = () => {}
  if (typeof view === 'function') {
    stop = effect(() => {
      let v: unknown
      try {
        v = (view as () => unknown)()
      } catch (e) {
        warn('view read threw; keeping previous content', e)
        return
      }
      untracked(() => region.apply(v))
    })
  } else {
    region.apply(view)
  }
  return {
    [Symbol.dispose]: () => {
      stop()
      region.destroy()
      marker.remove()
    },
  }
}

/** The DOM sink for core's generic mount(sink, view). */
export const domSink = (container: Element): Sink<VNode> => ({
  mount: (view) => mount(container, view as View),
})
