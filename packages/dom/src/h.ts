// Function-call view constructors. A call returns typed plain data
// ({ tag, attrs, children }) that any sink can walk — no strings are ever
// parsed as markup, which retires the whole build-DOM-from-strings bug class
// (XSS by construction, broken tables and SVG).

import type { Slot, VNode } from '@nonchalant/core'
import type { Attrs, AttrsFor } from './attrs.ts'

export type { Attrs, AttrsFor, HtmlAttrs, SvgAttrs } from './attrs.ts'

export type TagFn<K extends string = string> = (attrs?: AttrsFor<K>, ...children: Slot[]) => VNode

/** Generic constructor — for SVG, MathML, custom elements, or anything without a named export. */
export function h<K extends string>(tag: K, attrs?: AttrsFor<K>, ...children: Slot[]): VNode
export function h(tag: string, attrs: Attrs = {}, ...children: Slot[]): VNode {
  const ns = attrs['ns']
  return typeof ns === 'string' ? { tag, ns, attrs, children } : { tag, attrs, children }
}

export const tagFn: <K extends string>(tag: K) => TagFn<K> =
  (tag: string): TagFn =>
  (attrs = {}, ...children) =>
    h(tag, attrs, ...children)
