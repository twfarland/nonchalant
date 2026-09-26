// Structural diff and patch — the single update path for local and remote yields.
// reconcile(prev, next) emits ops on RFC 6901 JSON-pointer paths (pointer.ts);
// applyPatch(prev, ops) must reproduce next exactly (property-tested).
// Identity guards before recursion: path strings are only built along the changed
// spine (measured ~5x on 10k items).

import { arrayIndex, escapeSegment, parsePath } from './pointer.ts'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type Op =
  | ['set', path: string, value: Json]
  | ['del', path: string]
  | ['splice', path: string, start: number, remove: number, insert: Json[]]

export type Patch = Op[]

/** A plain object (prototype Object.prototype or null): the only record the diff descends into. */
export const isRecord = (v: unknown): v is { [key: string]: Json } => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// Object.hasOwn, not `in` or a bare index: a key like "toString" would find
// Object.prototype's and corrupt the diff
const own = (o: { [key: string]: Json }, k: string): Json | undefined => (Object.hasOwn(o, k) ? o[k] : undefined)

// ---------- diff ----------

export function reconcile(prev: Json, next: Json): Patch {
  const ops: Patch = []
  walk(prev, next, '', ops)
  return ops
}

// One function on purpose: splitting the array and record cases into their
// own functions measured ~15% slower on the 1-of-10k budget case.
function walk(prev: Json, next: Json, path: string, ops: Patch): void {
  if (Object.is(prev, next)) return
  if (Array.isArray(prev) && Array.isArray(next)) {
    // Trim the identity-shared prefix and suffix so a contiguous mid-array
    // insert or removal collapses to a single splice instead of per-index sets.
    const pLen = prev.length, nLen = next.length
    const minLen = Math.min(pLen, nLen)
    let start = 0
    while (start < minLen && Object.is(prev[start], next[start])) start++
    let suffix = 0
    while (suffix < minLen - start && Object.is(prev[pLen - 1 - suffix], next[nLen - 1 - suffix])) suffix++
    const pEnd = pLen - suffix, nEnd = nLen - suffix
    if (start === pEnd && start === nEnd) return
    if (start === pEnd) { ops.push(['splice', path, start, 0, next.slice(start, nEnd)]); return }
    if (start === nEnd) { ops.push(['splice', path, start, pEnd - start, []]); return }
    // Both windows non-empty: walk the overlap per index (indices agree in prev
    // and next coordinates here), then one splice for the length delta.
    const common = Math.min(pEnd, nEnd)
    for (let i = start; i < common; i++) {
      if (!Object.is(prev[i], next[i])) walk(prev[i] as Json, next[i] as Json, `${path}/${i}`, ops)
    }
    if (nEnd > pEnd) ops.push(['splice', path, common, 0, next.slice(common, nEnd)])
    else if (pEnd > nEnd) ops.push(['splice', path, common, pEnd - common, []])
    return
  }
  if (isRecord(prev) && isRecord(next)) {
    // a key holding undefined is absent (JSON has no undefined): never set,
    // and a key going to undefined is a del
    for (const k of Object.keys(prev)) {
      if (prev[k] !== undefined && own(next, k) === undefined) ops.push(['del', `${path}/${escapeSegment(k)}`])
    }
    for (const k of Object.keys(next)) {
      const n = next[k], p = own(prev, k)
      if (n === undefined || Object.is(p, n)) continue
      if (p === undefined) ops.push(['set', `${path}/${escapeSegment(k)}`, n])
      else walk(p, n, `${path}/${escapeSegment(k)}`, ops)
    }
    return
  }
  ops.push(['set', path, next])
}

// ---------- apply ----------

/** Pure: never mutates `doc`, the patch, or the patch's inserted values. */
export function applyPatch(doc: Json, patch: Patch): Json {
  // containers this call copied: nothing outside it holds them yet, so later
  // ops edit them in place and each container is copied at most once per patch
  const fresh = new Set<object>()
  let root = doc
  for (const op of patch) {
    const keys = parsePath(op[1])
    if (keys.length !== 0) root = applyAt(root, keys, 0, op, fresh)
    else if (op[0] === 'del') throw new Error('applyPatch: cannot del the root')
    else root = applyLeaf(root, op, fresh)
  }
  return root
}

/** `node` itself if this patch already copied it, else a copy it now owns. */
function writable<T extends Json[] | { [key: string]: Json }>(node: T, fresh: Set<object>): T {
  if (fresh.has(node)) return node
  const copy = (Array.isArray(node) ? node.slice() : { ...node }) as T
  fresh.add(copy)
  return copy
}

function applyAt(node: Json, keys: string[], i: number, op: Op, fresh: Set<object>): Json {
  const k = keys[i] as string
  const last = i === keys.length - 1

  if (Array.isArray(node)) {
    const idx = arrayIndex(k, node.length)
    const child = node[idx] as Json
    const copy = writable(node, fresh)
    copy[idx] = last ? applyLeaf(child, op, fresh) : applyAt(child, keys, i + 1, op, fresh)
    if (last && op[0] === 'del') copy.splice(idx, 1)
    return copy
  }
  if (isRecord(node)) {
    // a del, or a set of undefined (the same rule reconcile follows), removes the key
    const remove = last && op[0] !== 'splice' && (op as unknown[])[2] === undefined
    if ((remove ? op[0] === 'del' : !last) && !Object.hasOwn(node, k))
      throw new Error(`applyPatch: missing path segment ${JSON.stringify(k)}`)
    const child = node[k] as Json
    const copy = writable(node, fresh)
    if (remove) {
      delete copy[k]
      return copy
    }
    setOwn(copy, k, last ? applyLeaf(child, op, fresh) : applyAt(child, keys, i + 1, op, fresh))
    return copy
  }
  throw new Error('applyPatch: path descends into a non-container')
}

/** The op applied to the value it targets (a root op, or the last segment's). A `del` is the container's job. */
function applyLeaf(current: Json, op: Op, fresh: Set<object>): Json {
  switch (op[0]) {
    case 'set': return op[2]
    case 'splice': {
      if (!Array.isArray(current)) throw new Error('applyPatch: splice target is not an array')
      assertSplice(current, op)
      const copy = writable(current, fresh)
      copy.splice(op[2], op[3], ...op[4])
      return copy
    }
    case 'del': return current // unreachable for valid patches
  }
}

function assertSplice(target: Json[], op: Extract<Op, ['splice', ...unknown[]]>): void {
  const start = op[2]
  const remove = op[3]
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(remove) ||
    start < 0 ||
    remove < 0 ||
    start > target.length ||
    remove > target.length - start
  ) throw new Error(`applyPatch: bad splice range (${start}, ${remove}) for length ${target.length}`)
}

function setOwn(target: { [key: string]: Json }, key: string, value: Json): void {
  // an own data property (the copy's, from the spread) takes a plain write; a
  // new key is defined, so `__proto__` or a frozen inherited name can't intercept it
  if (Object.hasOwn(target, key)) {
    target[key] = value
    return
  }
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}
