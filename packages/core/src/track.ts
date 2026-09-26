// Path-recording read proxies — the "read tracked" half of the granularity
// mechanism. A Recorder wraps one snapshot for one reader run; finalize()
// distils what was touched into a PathTree that the source tests each patch
// against with affects() (paths.ts).
//
// Precision rules (what a read establishes a dependency on):
//   - a primitive read depends on exactly that path (and, conservatively, on
//     anything that later appears beneath it — shape drift);
//   - a container that is traversed *into* is not itself a dependency — only
//     the reads beneath it are;
//   - a container obtained but never read into has escaped the reader
//     (returned, stored, compared) — recorded as a subtree dependency;
//   - keys / length observations are structural — shape ops at that node
//     wake the reader. A direct-child `set` on an array is a replacement (a
//     length change is always a splice), so it does not count as shape;
//   - `in` / hasOwn / descriptor observations are presence-only — a set or
//     del at exactly that key wakes the reader, a change beneath it does not
//     (Object.keys reads every descriptor, so this is what keeps it shallow);
//   - documented approximation: a container that is both traversed and
//     escaped records as traversal only (a proxy cannot see identity use).
//
// Proxies are ephemeral: after finalize() they stop recording and hand out
// raw values, and the tree drops its proxy references so old snapshots are
// not retained across runs. unwrap.ts swaps them for their raw targets in a
// computed's return value.

import type { Json } from './reconcile.ts'
import type { PathTree } from './paths.ts'
import { isTrackable, targets } from './unwrap.ts'

interface RecNode extends PathTree {
  children: Map<string, RecNode> | null
  proxy: object | undefined
}

const mkNode = (): RecNode => ({
  children: null,
  leaf: false,
  structural: false,
  array: false,
  traversed: false,
  subtree: false,
  proxy: undefined,
})

export interface Recorder {
  wrap(value: Json): Json
  finalize(): PathTree
}

/** Proxies handed out so far, all recorders. A run that did not move it has no proxy to unwrap. */
export let handed = 0

const readonlyTrap = (): never => {
  throw new Error('nonchalant: snapshots are read-only — yield a new value instead of mutating')
}

// ---------- the recorder ----------

export function createRecorder(): Recorder {
  const root = mkNode()
  // flips at finalize, turning every proxy this run handed out into a pass-through
  let done = false

  const wrap = (value: Json, node: RecNode): Json => {
    if (typeof value !== 'object' || value === null) {
      if (!done) node.leaf = true
      return value
    }
    if (done) return value
    if (!isTrackable(value)) {
      node.leaf = true
      return value
    }
    node.traversed = true
    node.array = Array.isArray(value)
    handed++
    if (node.proxy !== undefined) return node.proxy as Json
    const proxy = new Proxy(value as object, traps(node))
    node.proxy = proxy
    targets.set(proxy, value)
    return proxy as Json
  }

  /** The handler for the proxy over the container recorded at `node`. */
  const traps = (node: RecNode): ProxyHandler<object> => ({
    get(target, key) {
      if (typeof key === 'symbol') return Reflect.get(target, key)
      if (done) return Reflect.get(target, key) // stale proxy after the run: raw values, no recording
      if (Array.isArray(target) && key === 'length') {
        node.structural = true
        return target.length
      }
      if (!Object.hasOwn(target, key)) {
        const v: unknown = Reflect.get(target, key)
        // prototype methods (map, slice, hasOwnProperty…): call sites keep
        // `this` = proxy, so the method's own reads still hit the traps
        if (typeof v === 'function') return v
        child(node, key).leaf = true // absent key observed — its appearance is a dependency
        return v
      }
      const value = (target as { [k: string]: Json })[key] as Json
      const next = child(node, key)
      // A Proxy must return the exact value of a frozen data property. Fall
      // back to a coarse dependency for that subtree rather than violating
      // the invariant by returning a nested proxy.
      if (typeof value === 'object' && value !== null && isPinned(target, key)) {
        next.traversed = true
        next.subtree = true
        return value
      }
      return wrap(value, next)
    },
    has(target, key) {
      if (!done && typeof key !== 'symbol') child(node, key)
      return Reflect.has(target, key)
    },
    ownKeys(target) {
      if (!done) node.structural = true
      return Reflect.ownKeys(target)
    },
    getOwnPropertyDescriptor(target, key) {
      if (!done && typeof key !== 'symbol') child(node, key)
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
    set: readonlyTrap,
    defineProperty: readonlyTrap,
    deleteProperty: readonlyTrap,
    setPrototypeOf: readonlyTrap,
  })

  return {
    wrap: (v) => wrap(v, root),
    finalize: () => {
      done = true
      seal(root)
      return root
    },
  }
}

function child(node: RecNode, key: string): RecNode {
  let map = node.children
  if (map === null) {
    map = new Map()
    node.children = map
  }
  let c = map.get(key)
  if (c === undefined) {
    c = mkNode()
    map.set(key, c)
  }
  return c
}

/** A non-configurable, non-writable data property: the one kind a get trap must return verbatim. */
export function isPinned(target: object, key: string): boolean {
  // an accessor descriptor has no `writable`, so it never matches
  const desc = Reflect.getOwnPropertyDescriptor(target, key)
  return desc?.writable === false && !desc.configurable
}

/** Drop proxy references, and promote containers obtained but never read into to subtree deps (escape is inferred, not trapped). */
function seal(node: RecNode): void {
  node.proxy = undefined
  const kids = node.children
  if (kids === null || kids.size === 0) {
    if (node.traversed && !node.structural && !node.leaf) node.subtree = true
    return
  }
  for (const c of kids.values()) seal(c)
}
