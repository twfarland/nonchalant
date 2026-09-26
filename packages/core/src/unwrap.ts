// Settling a computed's result: read proxies swapped for their raw targets, so
// identity, structuredClone and equality cuts behave as if tracking weren't
// there. The recorder (track.ts) registers each proxy it creates in `targets`.

import { isRecord } from './reconcile.ts'

/** Arrays and plain objects: the containers a recorder proxies and an unwrap walks. */
export const isTrackable = (value: object): boolean => Array.isArray(value) || isRecord(value)

// proxy → raw snapshot node; weak, so a proxy that escaped nowhere costs nothing
export const targets = new WeakMap<object, object>()

// plain containers an unwrap walked and found proxy-free: a static table or a
// structurally shared previous result is walked once, not on every recompute.
// One that held a proxy is left unmarked, so a getter that refills a reused
// container is walked again next run. The limit: a container found proxy-free
// and later mutated in place to hold one is not walked again (the
// immutable-update rule; tracking.md).
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

/** Swap the proxies held beneath `value` in place; true when it held none. */
function patch(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !isTrackable(value) || clean.has(value)) return true
  // marked before descending: a cycle back to it stops here
  clean.add(value)
  let free = true
  const box = value as { [key: string]: unknown }
  for (const k of Object.keys(box)) {
    const v = box[k]
    const raw = unproxy(v)
    if (raw !== v) {
      free = false
      Reflect.set(box, k, raw)
    } else if (!patch(v)) free = false
  }
  if (!free) clean.delete(value)
  return free
}
