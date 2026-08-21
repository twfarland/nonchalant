// Structural diff and patch — the single update path for local and remote yields.
// reconcile(prev, next) emits ops on JSON-pointer-style paths; applyPatch(prev, ops)
// must reproduce next exactly (property-tested). Identity guards before recursion:
// path strings are only built along the changed spine (measured ~5x on 10k items).
//
// TODO(protocol): RFC 6901 escaping for keys containing '/' or '~'. Until then,
// such keys are rejected by reconcile to keep the wire unambiguous.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type Op =
  | ['set', path: string, value: Json]
  | ['del', path: string]
  | ['splice', path: string, start: number, remove: number, insert: Json[]]

export type Patch = Op[]

const isRecord = (v: Json): v is { [key: string]: Json } =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const checkKey = (k: string): string => {
  if (k.includes('/') || k.includes('~'))
    throw new Error(`reconcile: unsupported key ${JSON.stringify(k)} (RFC 6901 escaping not yet implemented)`)
  return k
}

export function reconcile(prev: Json, next: Json): Patch {
  const ops: Patch = []
  walk(prev, next, '', ops)
  return ops
}

function walk(prev: Json, next: Json, path: string, ops: Patch): void {
  if (prev === next) return
  if (Array.isArray(prev) && Array.isArray(next)) {
    const n = Math.min(prev.length, next.length)
    for (let i = 0; i < n; i++) {
      if (prev[i] !== next[i]) walk(prev[i] as Json, next[i] as Json, `${path}/${i}`, ops)
    }
    if (next.length > prev.length) ops.push(['splice', path, prev.length, 0, next.slice(prev.length)])
    else if (next.length < prev.length) ops.push(['splice', path, next.length, prev.length - next.length, []])
    return
  }
  if (isRecord(prev) && isRecord(next)) {
    for (const k in prev) if (!(k in next)) ops.push(['del', `${path}/${checkKey(k)}`])
    for (const k in next) {
      if (prev[k] !== next[k]) {
        if (k in prev) walk(prev[k] as Json, next[k] as Json, `${path}/${checkKey(k)}`, ops)
        else ops.push(['set', `${path}/${checkKey(k)}`, next[k] as Json])
      }
    }
    return
  }
  ops.push(['set', path, next])
}

// ---------- apply ----------

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

function parsePath(path: string): string[] {
  if (path === '') return []
  const keys = path.slice(1).split('/')
  for (const k of keys)
    if (FORBIDDEN.has(k)) throw new Error(`applyPatch: illegal path segment ${JSON.stringify(k)}`)
  return keys
}

/** Pure: never mutates `doc`, the patch, or the patch's inserted values. */
export function applyPatch(doc: Json, patch: Patch): Json {
  let root = doc
  for (const op of patch) {
    const keys = parsePath(op[1])
    if (keys.length === 0) {
      if (op[0] === 'set') { root = op[2]; continue }
      if (op[0] === 'splice') {
        if (!Array.isArray(root)) throw new Error('applyPatch: splice target is not an array')
        const copy = root.slice()
        copy.splice(op[2], op[3], ...op[4])
        root = copy
        continue
      }
      throw new Error('applyPatch: cannot del the root')
    }
    root = applyAt(root, keys, 0, op)
  }
  return root
}

function applyAt(node: Json, keys: string[], i: number, op: Op): Json {
  const k = keys[i] as string
  const last = i === keys.length - 1

  if (Array.isArray(node)) {
    const idx = Number(k)
    if (!Number.isInteger(idx) || idx < 0 || idx > node.length)
      throw new Error(`applyPatch: bad array index ${JSON.stringify(k)}`)
    const copy = node.slice()
    copy[idx] = last ? applyLeaf(node[idx] as Json, op) : applyAt(node[idx] as Json, keys, i + 1, op)
    if (last && op[0] === 'del') copy.splice(idx, 1)
    return copy
  }
  if (isRecord(node)) {
    const copy: { [key: string]: Json } = { ...node }
    if (last && op[0] === 'del') { delete copy[k]; return copy }
    if (!last && !(k in node)) throw new Error(`applyPatch: missing path segment ${JSON.stringify(k)}`)
    copy[k] = last ? applyLeaf(node[k] as Json, op) : applyAt(node[k] as Json, keys, i + 1, op)
    return copy
  }
  throw new Error('applyPatch: path descends into a non-container')
}

function applyLeaf(current: Json, op: Op): Json {
  switch (op[0]) {
    case 'set': return op[2]
    case 'splice': {
      if (!Array.isArray(current)) throw new Error('applyPatch: splice target is not an array')
      const copy = current.slice()
      copy.splice(op[2], op[3], ...op[4])
      return copy
    }
    case 'del': return current // handled by the container; unreachable for valid patches
  }
}
