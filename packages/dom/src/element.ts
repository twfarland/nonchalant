// Elements: create, patch in place, dispose, and remove (through the `exit`
// hook when present). Construction is a patch from an empty element of the
// same tag, so creation and update cannot disagree about attribute order or
// property timing.

import { unbind } from '@nonchalant/core'
import type { Binding, VNode } from '@nonchalant/core'
import { patchAttrs } from './attribute.ts'
import { disposeChildRec, patchChildren } from './children.ts'
import type { ChildRec } from './children.ts'
import { dropHandlers } from './events.ts'
import { warn } from './report.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML'
export const XHTML_NS = 'http://www.w3.org/1999/xhtml'

export interface ElItem {
  el: Element
  vnode: VNode
  /** namespace the element's children render in */
  childNs: string
  /** live attribute bindings, by attribute name */
  fx: Map<string, Binding>
  children: ChildRec[]
}

/** The namespace an element is created in: explicit, then svg/math roots, then inherited. */
export function elementNs(tag: string, explicit: string | undefined, parentNs: string): string {
  if (explicit !== undefined) return explicit
  if (tag === 'svg') return SVG_NS
  if (tag === 'math') return MATHML_NS
  return parentNs
}

export function renderElement(doc: Document, vnode: VNode, parentNs: string): ElItem {
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

/**
 * Same-tag update in place: attributes, then children, then the property
 * attributes. Returns false when the element cannot be patched (tag/ns change)
 * and must be replaced.
 */
export function patchElement(doc: Document, item: ElItem, next: VNode): boolean {
  if (item.vnode === next) return true // reference-equal: skipped entirely
  // same tag under the same parent infers the same namespace; only an explicit ns can flip it
  if (next.tag !== item.vnode.tag || (next.ns !== undefined && next.ns !== item.el.namespaceURI))
    return false
  const prev = item.vnode.attrs
  patchAttrs(item, prev, next.attrs, false)
  patchChildren(doc, item, next.children)
  patchAttrs(item, prev, next.attrs, true)
  item.vnode = next
  return true
}

export function disposeElItem(item: ElItem): void {
  for (const b of item.fx.values()) unbind(b)
  item.fx.clear()
  dropHandlers(item.el)
  for (const rec of item.children) disposeChildRec(rec)
  item.children = []
}

export const hasExit = (item: ElItem): boolean => typeof item.vnode.attrs['exit'] === 'function'

/** Dispose, then detach — after the `exit` hook settles when there is one. */
export function removeElement(item: ElItem): void {
  disposeElItem(item)
  const el = item.el
  const exit = item.vnode.attrs['exit']
  if (typeof exit !== 'function') return el.remove()
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
}
