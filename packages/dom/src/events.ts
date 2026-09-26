// Event handlers. One listener function serves every element and event type
// and calls the current handler, so a swapped handler is a map write, not a
// DOM call, and disposal is dropping the map — a still-attached listener then
// finds nothing.

import { lint } from './report.ts'

const handlers = new WeakMap<Element, Record<string, EventListener>>()

function dispatch(this: Element, e: Event): void {
  handlers.get(this)?.[e.type]?.call(this, e)
}

/** The authoring mistake in an on* value, if any. Event names are used verbatim after `on`. */
export function handlerProblem(name: string, v: unknown): string | undefined {
  if (typeof v === 'function') {
    const type = name.slice(2)
    return type !== type.toLowerCase() ? `${name}: event names are lowercase` : undefined
  }
  // a string handler is script the browser would compile from text
  return v !== null && v !== undefined && v !== false ? `${name} must be a function` : undefined
}

/** Install, swap, or clear the handler for `on<type>`; only the first handler of a type touches the DOM. */
export function setHandler(el: Element, name: string, v: unknown): void {
  const type = name.slice(2)
  let on = handlers.get(el)
  if (on === undefined) handlers.set(el, (on = {}))
  const problem = handlerProblem(name, v)
  if (problem !== undefined) lint(problem)
  if (typeof v === 'function') {
    if (on[type] === undefined) el.addEventListener(type, dispatch)
    on[type] = v as EventListener
  } else delete on[type]
}

/**
 * Detach every handler of a disposed element. Without it, an element kept
 * alive by an exit animation would still call the handlers of the view that
 * removed it.
 */
export function dropHandlers(el: Element): void {
  handlers.delete(el)
}
