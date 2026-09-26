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
//
// The pieces: keyed.ts (matching and the LIS, no DOM), region.ts (dynamic
// slots), element.ts (create, patch, remove), children.ts (static children and
// holes), attribute.ts (values, properties, bindings), events.ts (handlers),
// report.ts (error and lint routing).

import { binding, unbind } from '@nonchalant/core'
import type { Binding, ProcessBase, Sink, VNode } from '@nonchalant/core'
import { XHTML_NS } from './element.ts'
import { createRegion, drive } from './region.ts'

export { onRenderError } from './report.ts'
export type { RenderErrorHandler } from './report.ts'

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
