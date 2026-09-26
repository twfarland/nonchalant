// Settling a computed's result: read proxies swapped for their raw targets, so
// identity, structuredClone and equality cuts behave as if tracking weren't
// there. The recorder (track.ts) registers each proxy it creates in `targets`.

import { isRecord } from './reconcile.ts'

/** Arrays and plain objects: the containers a recorder proxies and an unwrap walks. */
export const isTrackable = (value: object): boolean => Array.isArray(value) || isRecord(value)

// proxy → raw snapshot node; weak, so a proxy that escaped nowhere costs nothing
export const targets = new WeakMap<object, object>()

// plain containers an unwrap walked and left proxy-free: a static table or a
// structurally shared previous result is walked once, not on every recompute
const clean = new WeakSet<object>()

/** The raw snapshot node behind a read proxy, or the value itself. WeakMap#get answers undefined for primitives. */
export const unproxy = <T>(value: T): T => (targets.get(value as object) as T | undefined) ?? value

/**
 * Replace read proxies with their raw targets throughout a value. A proxy is
 * swapped whole (its target is raw snapshot data); the plain containers
 * around it were built by the getter, so they are patched in place (a frozen
 * one keeps its proxies). Non-plain objects (Date, Map, class instances) and
 * containers already known clean are not walked.
 */
export function unwrap<T>(value: T): T {
  const raw = unproxy(value)
  if (raw === value) patch(value)
  return raw
}

/** Swap the proxies held beneath `value` in place. */
function patch(value: unknown): void {
  if (typeof value !== 'object' || value === null || !isTrackable(value) || clean.has(value)) return
  // marked before descending: a cycle back to it stops here
  clean.add(value)
  const box = value as { [key: string]: unknown }
  for (const k of Object.keys(box)) {
    const v = box[k]
    const raw = unproxy(v)
    if (raw === v) patch(v)
    else if (!Reflect.set(box, k, raw)) clean.delete(value)
  }
}
