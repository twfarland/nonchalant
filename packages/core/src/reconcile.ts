// Structural diff and patch — the single update path for local and remote yields.
// reconcile(prev, next) emits ops on RFC 6901 JSON-pointer paths (`~` ⇒ `~0`,
// `/` ⇒ `~1`); applyPatch(prev, ops) must reproduce next exactly (property-tested).
// Identity guards before recursion: path strings are only built along the changed
// spine (measured ~5x on 10k items).

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type Op =
  | ['set', path: string, value: Json]
  | ['del', path: string]
  | ['splice', path: string, start: number, remove: number, insert: Json[]]

export type Patch = Op[]

const isRecord = (v: unknown): v is { [key: string]: Json } => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

const escapeSegment = (k: string): string =>
  k.includes('~') || k.includes('/') ? k.replaceAll('~', '~0').replaceAll('/', '~1') : k

function unescapeSegment(s: string): string {
  if (!s.includes('~')) return s
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '~') {
      const n = s[++i]
      if (n === '0') out += '~'
      else if (n === '1') out += '/'
      else throw new Error(`applyPatch: invalid escape in path segment ${JSON.stringify(s)}`)
    } else out += c
  }
  return out
}

export function reconcile(prev: Json, next: Json): Patch {
  const ops: Patch = []
  walk(prev, next, '', ops)
  return ops
}

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
    // Object.hasOwn, not `in`: `in` walks the prototype chain, so a key like
    // "toString" would find Object.prototype's and corrupt the diff
    for (const k of Object.keys(prev)) if (!Object.hasOwn(next, k)) ops.push(['del', `${path}/${escapeSegment(k)}`])
    for (const k of Object.keys(next)) {
      if (!Object.is(prev[k], next[k])) {
        if (Object.hasOwn(prev, k)) walk(prev[k] as Json, next[k] as Json, `${path}/${escapeSegment(k)}`, ops)
        else ops.push(['set', `${path}/${escapeSegment(k)}`, next[k] as Json])
      }
    }
    return
  }
  ops.push(['set', path, next])
}

// ---------- apply ----------

/** Internal (used by track.ts): decode an RFC 6901 pointer into segments. */
export function parsePath(path: string): string[] {
  if (path === '') return []
  if (path[0] !== '/') throw new Error(`applyPatch: path must start with "/" (${JSON.stringify(path)})`)
  const keys = path.slice(1).split('/')
  for (let i = 0; i < keys.length; i++) {
    const k = unescapeSegment(keys[i] as string)
    keys[i] = k
  }
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
        assertSplice(root, op)
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
    if (!Number.isInteger(idx) || idx < 0 || idx >= node.length)
      throw new Error(`applyPatch: bad array index ${JSON.stringify(k)}`)
    const copy = node.slice()
    copy[idx] = last ? applyLeaf(node[idx] as Json, op) : applyAt(node[idx] as Json, keys, i + 1, op)
    if (last && op[0] === 'del') copy.splice(idx, 1)
    return copy
  }
  if (isRecord(node)) {
    const copy: { [key: string]: Json } = { ...node }
    if (last && op[0] === 'del') {
      if (!Object.hasOwn(node, k)) throw new Error(`applyPatch: missing path segment ${JSON.stringify(k)}`)
      delete copy[k]
      return copy
    }
    if (!last && !Object.hasOwn(node, k)) throw new Error(`applyPatch: missing path segment ${JSON.stringify(k)}`)
    setOwn(copy, k, last ? applyLeaf(node[k] as Json, op) : applyAt(node[k] as Json, keys, i + 1, op))
    return copy
  }
  throw new Error('applyPatch: path descends into a non-container')
}

function applyLeaf(current: Json, op: Op): Json {
  switch (op[0]) {
    case 'set': return op[2]
    case 'splice': {
      if (!Array.isArray(current)) throw new Error('applyPatch: splice target is not an array')
      assertSplice(current, op)
      const copy = current.slice()
      copy.splice(op[2], op[3], ...op[4])
      return copy
    }
    case 'del': return current // handled by the container; unreachable for valid patches
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
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}
