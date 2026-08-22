// Path-recording read proxies + patch intersection — the "read tracked" half
// of the granularity mechanism. A Recorder wraps one snapshot
// for one reader run; finalize() distils what was touched into a PathTree that
// the source tests each patch against with affects().
//
// Precision rules (what a read establishes a dependency on):
//   - a primitive read depends on exactly that path (and, conservatively, on
//     anything that later appears beneath it — shape drift);
//   - a container that is traversed *into* is not itself a dependency — only
//     the reads beneath it are;
//   - a container obtained but never read into has escaped the reader
//     (returned, stored, compared) — recorded as a subtree dependency;
//   - keys / length / `in` observations are structural — shape ops at that
//     node wake the reader;
//   - documented approximation: a container that is both traversed and
//     escaped records as traversal only (a proxy cannot see identity use).
//
// Proxies are ephemeral: after finalize() they stop recording and hand out
// raw values, and the tree drops its proxy references so old snapshots are
// not retained across runs.

import { parsePath, type Json, type Op, type Patch } from './reconcile.ts'

export interface PathTree {
  children: Map<string, PathTree> | null
  /** A primitive (or absence) was read at this exact path. */
  leaf: boolean
  /** Keys / length / `in` were observed here — shape ops at this node wake. */
  structural: boolean
  /** A container was obtained here during the run. */
  traversed: boolean
  /** The container escaped the reader — any op at or below wakes. */
  subtree: boolean
}

interface RecNode extends PathTree {
  children: Map<string, RecNode> | null
  proxy: object | undefined
}

const mkNode = (): RecNode => ({
  children: null,
  leaf: false,
  structural: false,
  traversed: false,
  subtree: false,
  proxy: undefined,
})

export interface Recorder {
  wrap(value: Json): Json
  finalize(): PathTree
}

export function createRecorder(): Recorder {
  const root = mkNode()
  let done = false

  const child = (node: RecNode, key: string): RecNode => {
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

  const readonlyTrap = (): never => {
    throw new Error('nonchalant: snapshots are read-only — yield a new value instead of mutating')
  }

  const isTrackable = (value: object): boolean => {
    if (Array.isArray(value)) return true
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
  }

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
    if (node.proxy !== undefined) return node.proxy as Json
    const proxy = new Proxy(value as object, {
      get(target, key) {
        if (typeof key === 'symbol') return Reflect.get(target, key)
        if (done) return Reflect.get(target, key) // stale proxy after the run: raw values, no recording
        if (Array.isArray(target) && key === 'length') {
          node.structural = true
          return target.length
        }
        if (!Object.prototype.hasOwnProperty.call(target, key)) {
          const v: unknown = Reflect.get(target, key)
          // prototype methods (map, slice, hasOwnProperty…): call sites keep
          // `this` = proxy, so the method's own reads still hit the traps
          if (typeof v === 'function') return v
          child(node, key).leaf = true // absent key observed — its appearance is a dependency
          return v
        }
        const value = (target as { [k: string]: Json })[key] as Json
        const next = child(node, key)
        const desc = Reflect.getOwnPropertyDescriptor(target, key)
        // A Proxy must return the exact value of a frozen data property. Fall
        // back to a coarse dependency for that subtree rather than violating
        // the invariant by returning a nested proxy.
        if (
          desc !== undefined &&
          'writable' in desc &&
          desc.configurable === false &&
          desc.writable === false &&
          typeof value === 'object' &&
          value !== null
        ) {
          next.traversed = true
          next.subtree = true
          return value
        }
        return wrap(value, next)
      },
      has(target, key) {
        if (!done && typeof key !== 'symbol') child(node, key).leaf = true
        return Reflect.has(target, key)
      },
      ownKeys(target) {
        if (!done) node.structural = true
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, key) {
        if (!done && typeof key !== 'symbol') child(node, key).leaf = true
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      set: readonlyTrap,
      defineProperty: readonlyTrap,
      deleteProperty: readonlyTrap,
      setPrototypeOf: readonlyTrap,
    })
    node.proxy = proxy
    return proxy as Json
  }

  return {
    wrap: (v) => wrap(v, root),
    finalize: () => {
      done = true
      seal(root)
      return root
    },
  }
}

function seal(node: RecNode): void {
  node.proxy = undefined
  const kids = node.children
  if (kids === null || kids.size === 0) {
    if (node.traversed && !node.structural && !node.leaf) node.subtree = true
    return
  }
  for (const c of kids.values()) seal(c)
}

/** Does any op in the patch intersect the recorded read-paths? `segsList` carries the pre-parsed path per op — parse once per publish, not once per reader. */
export function affects(tree: PathTree, patch: Patch, segsList?: string[][]): boolean {
  for (let i = 0; i < patch.length; i++) {
    const op = patch[i]!
    if (opAffects(tree, op, segsList !== undefined ? segsList[i]! : parsePath(op[1]))) return true
  }
  return false
}

function opAffects(tree: PathTree, op: Op, segs: string[]): boolean {
  let node = tree
  for (let i = 0; i < segs.length; i++) {
    if (node.subtree || node.leaf) return true
    const key = segs[i] as string
    const c = node.children !== null ? node.children.get(key) : undefined
    if (i === segs.length - 1 && op[0] !== 'splice') {
      // set/del of the binding `key` under `node`: wakes if anything was read
      // at/below that binding, or if this node's key set was observed
      return c !== undefined || node.structural
    }
    if (c === undefined) return false
    node = c
  }
  // path consumed: op targets `node` itself — a root set, or any splice
  if (op[0] !== 'splice') return hasDep(node)
  if (node.subtree || node.leaf || node.structural) return true
  const start = op[2]
  const kids = node.children
  if (kids !== null) {
    // indices at/after the splice point shift or change — those reads wake
    for (const k of kids.keys()) {
      const idx = Number(k)
      if (Number.isInteger(idx) && idx >= start) return true
    }
  }
  return false
}

function hasDep(n: PathTree): boolean {
  return n.leaf || n.structural || n.subtree || n.traversed || (n.children !== null && n.children.size > 0)
}
