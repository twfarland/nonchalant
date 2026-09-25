// The DOM sink. Interprets VNode trees (plain data) into real nodes:
// createElement / createTextNode / setAttribute only — no string is ever
// parsed as markup, so markup injection is impossible by construction. Two
// attribute-level injection routes are closed too: javascript: URLs in URL
// attributes are dropped, and on* attributes take only functions.
//
// Granularity: static structure renders once; every dynamic slot (a thunk or a
// process placed in the tree) becomes a marker-anchored *region* driven by one
// effect. The effect's tracked read decides when the region wakes; the region
// then reconciles its rendered children against the new value — the one honest
// localized keyed diff: reference-equal vnodes are
// skipped, matched keys patch in place (`key: 0` is a key — presence, not
// truthiness), absent keys dispose (deferred through the `exit` hook when
// present), and surviving nodes outside a longest increasing subsequence of
// their old positions move — n − LIS moves, the minimum.
//
// Writes are skipped when the DOM already holds the value, so a binding that
// re-runs costs a read, not a write. A fresh closure from a parent re-render
// is swapped into the existing binding (core's `rebind`): one re-run on the
// same effect node, never a dispose-and-recreate.
//
// Per-slot pending/error: a promise slot holds only its own region (empty until
// it settles; rejection logs and stays empty); a throwing binding logs and
// keeps its previous content. Nothing above re-renders, nothing below unmounts.
//
// Item construction inside a region runs `untracked` so nested bindings become
// independent effects (owned by the item's disposer, not the region's effect —
// a region re-run must not tear down the bindings of items it reuses).

import { binding, rebind, unbind, untracked } from '@nonchalant/core'
import type { Binding, ProcessBase, Sink, Slot, VNode } from '@nonchalant/core'

const SVG_NS = 'http://www.w3.org/2000/svg'
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

const SPECIAL_ATTRS = new Set(['key', 'exit', 'ns'])
// interactive state lives on the property, not the attribute, and is applied
// after children: a <select>'s value can only match options that already exist
const PROP_ATTRS = new Set(['value', 'checked', 'selected'])
// navigating to a javascript: URL runs it
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href'])

type Disposer = () => void

type Probe = { tag?: unknown; children?: unknown; then?: unknown; [Symbol.asyncIterator]?: unknown } | null | undefined

const isVNode = (v: unknown): v is VNode =>
  typeof (v as Probe)?.tag === 'string' && Array.isArray((v as Probe)?.children)

const isAsyncIterable = (v: unknown): v is AsyncIterable<unknown> =>
  typeof (v as Probe)?.[Symbol.asyncIterator] === 'function'

const isPromise = (v: unknown): v is Promise<unknown> => typeof (v as Probe)?.then === 'function'

export type RenderErrorHandler = (what: string, error: unknown) => void

// render-time failures (a throwing binding, a rejected slot promise) are
// contained to their region; this hook only decides where the report goes
let report: RenderErrorHandler = (what, e) => console.error(`nonchalant/dom: ${what}`, e)

/** Route render failure reports somewhere other than console.error. Returns a restore function. */
export function onRenderError(handler: RenderErrorHandler): () => void {
  const prev = report
  report = handler
  return () => {
    report = prev
  }
}

const warn = (what: string, e?: unknown): void => report(what, e)

// authoring mistakes: each distinct message once, not once per row
const linted = new Set<string>()
const lint = (what: string): void => {
  if (linted.has(what)) return
  linted.add(what)
  console.warn(`nonchalant/dom: ${what}`)
}

// ---------- elements ----------

interface ElItem {
  el: Element
  vnode: VNode
  /** namespace the element's children render in */
  childNs: string
  /** live attribute bindings, by attribute name */
  fx: Map<string, Binding>
  children: ChildRec[]
}

// One listener function serves every element and event type and calls the
// current handler, so a swapped handler is a map write, not a DOM call, and
// disposal is dropping the map — a still-attached listener then finds nothing.
const handlers = new WeakMap<Element, Record<string, EventListener>>()

function dispatch(this: Element, e: Event): void {
  handlers.get(this)?.[e.type]?.call(this, e)
}

type ChildRec =
  | { kind: 'empty' }
  | { kind: 'text'; node: Text; value: string; slot: Slot }
  | { kind: 'el'; item: ElItem; slot: Slot }
  // a function slot's stop is its binding (rebindable); promise/iterable holes get a disposer
  | { kind: 'hole'; slot: Slot; marker: Comment; region: Region; stop: Disposer | Binding }

const recFirstNode = (rec: ChildRec): ChildNode | null =>
  rec.kind === 'text' ? rec.node : rec.kind === 'el' ? rec.item.el : rec.kind === 'hole' ? rec.region.first() : null

function elementNs(tag: string, explicit: string | undefined, parentNs: string): string {
  if (explicit !== undefined) return explicit
  if (tag === 'svg') return SVG_NS
  if (tag === 'math') return MATHML_NS
  return parentNs
}

function renderElement(doc: Document, vnode: VNode, parentNs: string): ElItem {
  const ns = elementNs(vnode.tag, vnode.ns, parentNs)
  const item: ElItem = {
    el: ns === XHTML_NS ? doc.createElement(vnode.tag) : doc.createElementNS(ns, vnode.tag),
    // construction is a patch from an empty element of the same tag
    vnode: { tag: vnode.tag, attrs: {}, children: [] },
    childNs: vnode.tag === 'foreignObject' ? XHTML_NS : ns,
    fx: new Map(),
    children: [],
  }
  patchElement(doc, item, vnode)
  return item
}

function setAttrValue(el: Element, name: string, v: unknown): void {
  if (PROP_ATTRS.has(name) && name in el) {
    const props = el as unknown as Record<string, unknown>
    if (props[name] !== v) props[name] = v
    return
  }
  // browsers strip whitespace and control characters before reading the scheme
  if (URL_ATTRS.has(name) && /^javascript:/i.test(String(v).replace(/[\0-\x20]/g, ''))) {
    lint(`blocked a javascript: URL in ${name}`)
    v = null
  }
  // aria-* takes enumerated strings, not HTML boolean presence: aria-pressed
  // must read "false", and an absent one means "not a toggle" instead
  if (typeof v === 'boolean' && name.startsWith('aria-')) v = String(v)
  if (typeof v === 'object' && v !== null) lint(`${name} was given an object, not a string`)
  const s = v === null || v === undefined || v === false ? null : v === true ? '' : String(v)
  if (s === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name)
  } else if (el.getAttribute(name) !== s) el.setAttribute(name, s)
}

const attrBody = (el: Element, name: string, read: () => unknown) => (): void => {
  let value: unknown
  try {
    value = read()
  } catch (e) {
    warn(`attribute "${name}" threw; keeping previous content`, e)
    return
  }
  setAttrValue(el, name, value)
}

/**
 * Apply one attribute value, replacing whatever was bound under that name. A
 * binding replaced by another binding keeps its effect and never passes
 * through null: the new body's first value lands over the old one, and only
 * if it differs.
 */
function applyAttr(item: ElItem, name: string, v: unknown): void {
  if (SPECIAL_ATTRS.has(name)) return
  const el = item.el
  const on = name.startsWith('on')
  const bound = item.fx.get(name)
  if (!on && typeof v === 'function') {
    // reactive binding: thunk or process — same shape, same handling
    const body = attrBody(el, name, v as () => unknown)
    if (bound !== undefined) rebind(bound, body)
    else item.fx.set(name, binding(body))
    return
  }
  if (bound !== undefined) {
    unbind(bound)
    item.fx.delete(name)
  }
  if (on) {
    const type = name.slice(2)
    let on = handlers.get(el)
    if (on === undefined) handlers.set(el, (on = {}))
    if (typeof v === 'function') {
      if (type !== type.toLowerCase()) lint(`${name}: event names are lowercase`)
      if (on[type] === undefined) el.addEventListener(type, dispatch)
      on[type] = v as EventListener
    } else {
      // a string handler is script the browser would compile from text
      if (v !== null && v !== undefined && v !== false) lint(`${name} must be a function`)
      delete on[type]
    }
    return
  }
  setAttrValue(el, name, v)
}

function disposeElItem(item: ElItem): void {
  for (const b of item.fx.values()) unbind(b)
  item.fx.clear()
  handlers.delete(item.el)
  for (const rec of item.children) disposeChildRec(rec)
  item.children = []
}

// ---------- static children ----------

const flattenStatic = (children: readonly Slot[]): Slot[] => children.flat(Infinity as 1) as Slot[]

/** A region's binding body for a thunk or process; a callable result is read through (a thunk may return a process). */
const drive = (region: Region, read: () => unknown, what: string) => (): void => {
  let v: unknown = read
  try {
    while (typeof v === 'function') v = (v as () => unknown)()
  } catch (e) {
    warn(`${what} threw; keeping previous content`, e)
    return
  }
  untracked(() => region.apply(v))
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
  if (isVNode(slot)) {
    const item = renderElement(doc, slot, ns)
    parent.insertBefore(item.el, anchor)
    return { kind: 'el', item, slot }
  }
  const marker = doc.createComment('')
  parent.insertBefore(marker, anchor)
  const region = createRegion(doc, parent, marker, ns)
  const hole = (stop: Disposer | Binding): ChildRec => ({ kind: 'hole', slot, marker, region, stop })
  if (typeof slot === 'function') return hole(binding(drive(region, slot, 'slot binding')))
  let dead = false
  if (isPromise(slot)) {
    slot.then(
      (v) => {
        if (!dead) untracked(() => region.apply(v))
      },
      (e) => {
        if (!dead) warn('slot promise rejected; keeping content', e)
      },
    )
    return hole(() => {
      dead = true
    })
  }
  if (isAsyncIterable(slot)) {
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
    return hole(() => {
      dead = true
      // a silent iterator never resolves next(); closing it releases the
      // subscription it holds (a process iterator's effect, a generator's finally)
      void Promise.resolve(it.return?.()).catch(() => {})
    })
  }
  region.apply(slot) // unsupported: reports and renders nothing
  return hole(() => {})
}

function disposeChildRec(rec: ChildRec): void {
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

// ---------- patching (same-tag element update in place) ----------

/** Returns false when the element cannot be patched (tag/ns change) and must be replaced. */
function patchElement(doc: Document, item: ElItem, next: VNode): boolean {
  if (item.vnode === next) return true // reference-equal: skipped entirely
  // same tag under the same parent infers the same namespace; only an explicit ns can flip it
  if (next.tag !== item.vnode.tag || (next.ns !== undefined && next.ns !== item.el.namespaceURI))
    return false
  const oldAttrs = item.vnode.attrs
  const newAttrs = next.attrs
  const patchAttrs = (props: boolean): void => {
    for (const name of Object.keys(oldAttrs)) {
      if (PROP_ATTRS.has(name) === props && !(name in newAttrs)) applyAttr(item, name, null)
    }
    for (const name of Object.keys(newAttrs)) {
      // unchanged, including the same function reference: binding untouched
      if (PROP_ATTRS.has(name) === props && newAttrs[name] !== oldAttrs[name]) applyAttr(item, name, newAttrs[name])
    }
  }
  patchAttrs(false)
  patchChildren(doc, item, next.children)
  patchAttrs(true)
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
    next.push(old !== undefined ? patchChildRec(doc, item, old, slot) : createChildRec(doc, item.el, slot, item.childNs, null))
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

/**
 * Marks one longest strictly increasing subsequence of `from` (old positions;
 * -1 = new, never kept). Kept nodes are already in relative order and stay;
 * every other node moves, so moves = survivors − LIS, the minimum possible.
 */
export function keepers(from: readonly number[]): boolean[] {
  const tails: number[] = [] // tails[k]: index ending the best run of length k + 1
  const prev: number[] = []
  for (let i = 0; i < from.length; i++) {
    const v = from[i] as number
    if (v < 0) continue
    let lo = 0
    let hi = tails.length
    // in-order runs (appends, in-place updates) extend the tail without a search
    if (hi > 0 && (from[tails[hi - 1] as number] as number) < v) lo = hi
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((from[tails[mid] as number] as number) < v) lo = mid + 1
      else hi = mid
    }
    prev[i] = lo > 0 ? (tails[lo - 1] as number) : -1
    tails[lo] = i
  }
  const keep: boolean[] = []
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i] as number) keep[i] = true
  return keep
}

type Movable = Node & { moveBefore?: (node: Node, child: Node | null) => void }

function createRegion(doc: Document, parent: Node, marker: Comment, ns: string): Region {
  let items: RegionItem[] = []


  const removeItem = (it: RegionItem): void => {
    if (it.kind === 'text') return it.node.remove()
    const { item } = it
    disposeElItem(item)
    const el = item.el
    const exit = item.vnode.attrs['exit']
    if (typeof exit === 'function') {
      // leaving: out of the accessibility tree and the focus order while it animates
      el.setAttribute('inert', '')
      let res: unknown
      try {
        res = (exit as (el: Element) => unknown)(el)
      } catch (e) {
        warn('exit hook threw; removing immediately', e)
        el.remove()
        return
      }
      void Promise.resolve(res).then(
        () => el.remove(),
        () => el.remove(),
      )
      return
    }
    el.remove()
  }

  // Dispose everything now, skipping exit transitions. When the region is its
  // parent's whole content, one replaceChildren replaces a removal per item.
  const wipe = (): void => {
    for (const it of items) if (it.kind === 'el') disposeElItem(it.item)
    if (items.length > 0 && parent.childNodes.length === items.length + 1) {
      ;(parent as Element).replaceChildren(marker)
    } else for (const it of items) itemNode(it).remove()
    items = []
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
    for (const v of [value].flat(Infinity as 1)) {
      if (typeof v === 'string' || typeof v === 'number') flat.push(String(v))
      else if (isVNode(v)) flat.push(v)
      else if (v !== null && v !== undefined && typeof v !== 'boolean') warn(`unsupported value in dynamic slot (${typeof v}); skipping`)
    }
    const olds = items
    if (flat.length === 0 && olds.every((it) => it.kind === 'text' || typeof it.item.vnode.attrs['exit'] !== 'function')) return wipe()

    const byKey = new Map<unknown, number>()
    olds.forEach((it, i) => {
      if (it.kind === 'el' && 'key' in it.item.vnode.attrs) byKey.set(it.item.vnode.attrs['key'], i)
    })
    const used: boolean[] = []
    let oldIdx = 0
    const takePositional = (): number => {
      while (used[oldIdx]) oldIdx++
      return oldIdx
    }

    const next: RegionItem[] = []
    const from: number[] = [] // old position of each next item; -1 = new
    for (const r of flat) {
      let i = -1
      if (typeof r === 'string') {
        const c = takePositional()
        const cand = olds[c]
        if (cand?.kind === 'text') {
          i = c
          oldIdx++
          if (cand.value !== r) {
            cand.node.data = r
            cand.value = r
          }
        }
      } else {
        const keyed = 'key' in r.attrs
        const c = keyed ? byKey.get(r.attrs['key']) : takePositional()
        const cand = c === undefined || used[c] ? undefined : olds[c]
        if (cand?.kind === 'el' && keyed === ('key' in cand.item.vnode.attrs) && cand.item.vnode.tag === r.tag) {
          if (!keyed) oldIdx++
          // tag matched but an explicit ns flipped: rebuild
          if (patchElement(doc, cand.item, r)) i = c as number
        }
      }
      if (i >= 0) used[i] = true
      from.push(i)
      next.push(
        i >= 0
          ? (olds[i] as RegionItem)
          : typeof r === 'string'
            ? { kind: 'text', node: doc.createTextNode(r), value: r }
            : { kind: 'el', item: renderElement(doc, r, ns) },
      )
    }

    olds.forEach((it, i) => {
      if (!used[i]) removeItem(it)
    })

    const keep = keepers(from)
    // moveBefore (where supported) keeps focus, selection, and animations across a move
    const p = parent as Movable
    const move = p.moveBefore !== undefined && p.isConnected
    let anchor: ChildNode = marker
    for (let i = next.length - 1; i >= 0; i--) {
      const node = itemNode(next[i] as RegionItem)
      if (!keep[i]) {
        if (move && (from[i] as number) >= 0) p.moveBefore!(node, anchor)
        else parent.insertBefore(node, anchor)
      }
      anchor = node
    }
    items = next
  }

  return {
    apply,
    destroy: () => {
      destroyed = true
      wipe()
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
  let fx: Binding | undefined
  if (typeof view === 'function') fx = binding(drive(region, view, 'view read'))
  else region.apply(view)
  return {
    [Symbol.dispose]: () => {
      if (fx !== undefined) unbind(fx)
      region.destroy()
      marker.remove()
    },
  }
}

/** The DOM sink for core's generic mount(sink, view). */
export const domSink = (container: Element): Sink<VNode> => ({
  mount: (view) => mount(container, view as View),
})
