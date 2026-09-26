// Regions: marker-anchored dynamic slots, each owning the items rendered
// before its marker. `apply` reconciles those items against a new value — the
// one honest localized keyed diff (see keyed.ts for matching and the moves
// planner); this module does the DOM half.

import { untracked } from '@nonchalant/core'
import type { VNode } from '@nonchalant/core'
import { disposeElItem, hasExit, patchElement, removeElement, renderElement } from './element.ts'
import type { ElItem } from './element.ts'
import { keepers, match } from './keyed.ts'
import { warn } from './report.ts'

type Probe = { tag?: unknown; children?: unknown; then?: unknown; [Symbol.asyncIterator]?: unknown } | null | undefined

export const isVNode = (v: unknown): v is VNode =>
  typeof (v as Probe)?.tag === 'string' && Array.isArray((v as Probe)?.children)

export const isAsyncIterable = (v: unknown): v is AsyncIterable<unknown> =>
  typeof (v as Probe)?.[Symbol.asyncIterator] === 'function'

export const isPromise = (v: unknown): v is Promise<unknown> => typeof (v as Probe)?.then === 'function'

type RegionItem =
  | { kind: 'text'; node: Text; value: string }
  | { kind: 'el'; item: ElItem }

export interface Region {
  apply(value: unknown): void
  /** Immediate teardown (no exit transitions); the marker is the caller's. */
  destroy(): void
  first(): ChildNode
}

const itemNode = (it: RegionItem): ChildNode => (it.kind === 'text' ? it.node : it.item.el)

const itemExits = (it: RegionItem): boolean => it.kind === 'el' && hasExit(it.item)

/** A region's binding body for a thunk or process; a callable result is read through (a thunk may return a process). */
export const drive = (region: Region, read: () => unknown, what: string) => (): void => {
  let v: unknown = read
  try {
    while (typeof v === 'function') v = (v as () => unknown)()
  } catch (e) {
    warn(`${what} threw; keeping previous content`, e)
    return
  }
  untracked(() => region.apply(v))
}

/** A dynamic slot's value as the strings and vnodes it renders; anything else is reported and skipped. */
export function flattenDynamic(value: unknown): (string | VNode)[] {
  const flat: (string | VNode)[] = []
  for (const v of [value].flat(Infinity as 1)) {
    if (typeof v === 'string' || typeof v === 'number') flat.push(String(v))
    else if (isVNode(v)) flat.push(v)
    else if (v !== null && v !== undefined && typeof v !== 'boolean') warn(`unsupported value in dynamic slot (${typeof v}); skipping`)
  }
  return flat
}

type Movable = Node & { moveBefore?: (node: Node, child: Node | null) => void }

/**
 * Put `next` in order before `marker`, touching only nodes outside the kept
 * subsequence: n − LIS moves for n survivors, plus one insert per new item.
 */
function place(parent: Node, marker: Comment, next: readonly RegionItem[], from: readonly number[]): void {
  const keep = keepers(from)
  // moveBefore (where supported) keeps focus, selection, and animations across a move
  const p = parent as Movable
  const move = p.moveBefore !== undefined && p.isConnected
  let anchor: ChildNode = marker
  for (let i = next.length - 1; i >= 0; i--) {
    const node = itemNode(next[i] as RegionItem)
    if (!keep[i]) {
      if (move && (from[i] as number) >= 0) p.moveBefore!(node, anchor)
      else parent.insertBefore(node, anchor)
    }
    anchor = node
  }
}

export function createRegion(doc: Document, parent: Node, marker: Comment, ns: string): Region {
  let items: RegionItem[] = []

  // Dispose everything now, skipping exit transitions. When the region is its
  // parent's whole content, one replaceChildren replaces a removal per item.
  const wipe = (): void => {
    for (const it of items) if (it.kind === 'el') disposeElItem(it.item)
    if (items.length > 0 && parent.childNodes.length === items.length + 1) {
      ;(parent as Element).replaceChildren(marker)
    } else for (const it of items) itemNode(it).remove()
    items = []
  }

  // a promise value keeps current content until it settles (lazy routes: a
  // thunk returning import(...).then(...)); a newer value supersedes it
  let pendingToken = 0
  let destroyed = false

  const apply = (value: unknown): void => {
    const token = ++pendingToken
    if (isPromise(value)) {
      value.then(
        (v) => {
          if (!destroyed && token === pendingToken) applyNow(v)
        },
        (e) => {
          if (!destroyed && token === pendingToken) warn('slot promise rejected; keeping content', e)
        },
      )
      return
    }
    applyNow(value)
  }

  const applyNow = (value: unknown): void => {
    const flat = flattenDynamic(value)
    const olds = items
    if (flat.length === 0 && !olds.some(itemExits)) return wipe()

    const used: boolean[] = []
    const from = match(olds, flat, used)
    const next: RegionItem[] = []
    for (let i = 0; i < flat.length; i++) {
      const r = flat[i] as string | VNode
      const c = from[i] as number
      const old = olds[c]
      if (old?.kind === 'text') {
        if (old.value !== r) {
          old.node.data = r as string
          old.value = r as string
        }
      } else if (old !== undefined && !patchElement(doc, old.item, r as VNode)) {
        // tag matched but an explicit ns flipped: rebuild
        used[c] = false
        from[i] = -1
      }
      next.push(
        (from[i] as number) >= 0
          ? (old as RegionItem)
          : typeof r === 'string'
            ? { kind: 'text', node: doc.createTextNode(r), value: r }
            : { kind: 'el', item: renderElement(doc, r, ns) },
      )
    }

    for (let i = 0; i < olds.length; i++) {
      const it = olds[i] as RegionItem
      if (used[i]) continue
      if (it.kind === 'text') it.node.remove()
      else removeElement(it.item)
    }

    place(parent, marker, next, from)
    items = next
  }

  return {
    apply,
    destroy: () => {
      destroyed = true
      wipe()
    },
    first: () => (items.length > 0 ? itemNode(items[0] as RegionItem) : marker),
  }
}
