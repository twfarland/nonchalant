// Attribute writes: plain values, properties, bindings, and handlers, with the
// attribute-level injection routes closed (javascript: URLs dropped, on* takes
// only functions). Writes are skipped when the DOM already holds the value, so
// a binding that re-runs costs a read, not a write.

import { binding, rebind, unbind } from '@nonchalant/core'
import type { VNode } from '@nonchalant/core'
import type { ElItem } from './element.ts'
import { setHandler } from './events.ts'
import { lint, warn } from './report.ts'

export const SPECIAL_ATTRS = new Set(['key', 'exit', 'ns'])
// interactive state lives on the property, not the attribute, and is applied
// after children: a <select>'s value can only match options that already exist
export const PROP_ATTRS = new Set(['value', 'checked', 'selected'])
// navigating to a javascript: URL runs it
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href'])

// browsers strip whitespace and control characters before reading the scheme
const IGNORED_IN_SCHEME = /[\0-\x20]/g
const JAVASCRIPT_SCHEME = /^javascript:/i

/** Whether navigating to `v` would run script, read the way a browser reads the scheme. */
export const isJavascriptUrl = (v: unknown): boolean =>
  JAVASCRIPT_SCHEME.test(String(v).replace(IGNORED_IN_SCHEME, ''))

/** The attribute text for a value; null means absent. */
export function attrText(name: string, v: unknown): string | null {
  // aria-* takes enumerated strings, not HTML boolean presence: aria-pressed
  // must read "false", and an absent one means "not a toggle" instead
  if (typeof v === 'boolean' && name.startsWith('aria-')) return String(v)
  return v === null || v === undefined || v === false ? null : v === true ? '' : String(v)
}

export function setAttrValue(el: Element, name: string, v: unknown): void {
  if (PROP_ATTRS.has(name) && name in el) {
    const props = el as unknown as Record<string, unknown>
    if (props[name] !== v) props[name] = v
    return
  }
  if (URL_ATTRS.has(name) && isJavascriptUrl(v)) {
    lint(`blocked a javascript: URL in ${name}`)
    v = null
  }
  if (typeof v === 'object' && v !== null) lint(`${name} was given an object, not a string`)
  const s = attrText(name, v)
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
export function applyAttr(item: ElItem, name: string, v: unknown): void {
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
  if (on) setHandler(el, name, v)
  else setAttrValue(el, name, v)
}

/**
 * One pass of an attribute diff over either the property attributes or the
 * rest: names gone from `next` are cleared, names whose value is a different
 * reference are re-applied, and the same reference (the same binding function
 * included) is left alone.
 */
export function patchAttrs(item: ElItem, prev: VNode['attrs'], next: VNode['attrs'], props: boolean): void {
  for (const name of Object.keys(prev)) {
    if (PROP_ATTRS.has(name) === props && !(name in next)) applyAttr(item, name, null)
  }
  for (const name of Object.keys(next)) {
    if (PROP_ATTRS.has(name) === props && next[name] !== prev[name]) applyAttr(item, name, next[name])
  }
}
