// Function-call view constructors. A call returns typed plain data
// ({ tag, attrs, children }) that any sink can walk — no strings are ever
// parsed as markup, which retires the whole build-DOM-from-strings bug class
// (XSS by construction, broken tables and SVG).

import type { Slot, VNode } from '@nonchalant/core'

export interface Attrs {
  /** Identity for keyed reconciliation. `key: 0` is a valid key (presence, not truthiness). */
  readonly key?: unknown
  /** Exit-transition hook: called with the element on removal; detach waits for the result. */
  readonly exit?: (el: Element) => unknown
  /** Explicit namespace for the element (otherwise inferred: svg/math subtrees). */
  readonly ns?: string
  /**
   * Everything else: static values, `on*` listeners (functions), or reactive
   * bindings (thunks / processes — any callable that is not an `on*` name).
   */
  readonly [name: string]: unknown
}

/** Generic constructor — for SVG, MathML, custom elements, or anything without a named export. */
export function h(tag: string, attrs: Attrs = {}, ...children: Slot[]): VNode {
  const ns = attrs['ns']
  return typeof ns === 'string' ? { tag, ns, attrs, children } : { tag, attrs, children }
}

export type TagFn = (attrs?: Attrs, ...children: Slot[]) => VNode

export const tagFn =
  (tag: string): TagFn =>
  (attrs: Attrs = {}, ...children: Slot[]): VNode =>
    h(tag, attrs, ...children)
