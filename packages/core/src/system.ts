// Faithful port of the alien-signals reactive system — the push–pull
// propagation core this library standardises on.
// Upstream: stackblitz/alien-signals src/system.ts, MIT,
// Copyright (c) 2024-present Johnson Chu — full license text in
// THIRD-PARTY-NOTICES.md at the repo root. Restyled to house conventions;
// the logic is 1:1 with upstream. Constraints preserved: no Array/Set/Map in
// the hot path (intrusive doubly-linked dependency lists, integer bitflags),
// no recursion (explicit link stacks in propagate/checkDirty).

export interface ReactiveNode {
  deps: Link | undefined
  depsTail: Link | undefined
  subs: Link | undefined
  subsTail: Link | undefined
  flags: number
}

export interface Link {
  version: number
  dep: ReactiveNode
  sub: ReactiveNode
  prevSub: Link | undefined
  nextSub: Link | undefined
  prevDep: Link | undefined
  nextDep: Link | undefined
}

interface Stack<T> {
  value: T
  prev: Stack<T> | undefined
}

// ReactiveFlags (bitfield on ReactiveNode.flags)
export const MUTABLE = 1
export const WATCHING = 2
export const RECURSED_CHECK = 4
export const RECURSED = 8
export const DIRTY = 16
export const PENDING = 32

export function createReactiveSystem({
  update,
  notify,
  unwatched,
}: {
  update(sub: ReactiveNode): boolean
  notify(sub: ReactiveNode): void
  unwatched(sub: ReactiveNode): void
}) {
  return {
    link,
    unlink,
    propagate,
    checkDirty,
    shallowPropagate,
  }

  function link(dep: ReactiveNode, sub: ReactiveNode, version: number): void {
    const prevDep = sub.depsTail
    if (prevDep !== undefined && prevDep.dep === dep) {
      return
    }
    const nextDep = prevDep !== undefined ? prevDep.nextDep : sub.deps
    if (nextDep !== undefined && nextDep.dep === dep) {
      nextDep.version = version
      sub.depsTail = nextDep
      return
    }
    const prevSub = dep.subsTail
    if (prevSub !== undefined && prevSub.version === version && prevSub.sub === sub) {
      return
    }
    const newLink: Link = {
      version,
      dep,
      sub,
      prevDep,
      nextDep,
      prevSub,
      nextSub: undefined,
    }
    sub.depsTail = newLink
    dep.subsTail = newLink
    if (nextDep !== undefined) {
      nextDep.prevDep = newLink
    }
    if (prevDep !== undefined) {
      prevDep.nextDep = newLink
    } else {
      sub.deps = newLink
    }
    if (prevSub !== undefined) {
      prevSub.nextSub = newLink
    } else {
      dep.subs = newLink
    }
  }

  function unlink(link: Link, sub = link.sub): Link | undefined {
    const { dep, prevDep, nextDep, nextSub, prevSub } = link
    if (nextDep !== undefined) {
      nextDep.prevDep = prevDep
    } else {
      sub.depsTail = prevDep
    }
    if (prevDep !== undefined) {
      prevDep.nextDep = nextDep
    } else {
      sub.deps = nextDep
    }
    if (nextSub !== undefined) {
      nextSub.prevSub = prevSub
    } else {
      dep.subsTail = prevSub
    }
    if (prevSub !== undefined) {
      prevSub.nextSub = nextSub
    } else if ((dep.subs = nextSub) === undefined) {
      unwatched(dep)
    }
    return nextDep
  }

  function propagate(link: Link, innerWrite: boolean): void {
    let next = link.nextSub
    let stack: Stack<Link | undefined> | undefined

    top: do {
      const sub = link.sub
      let flags = sub.flags

      if (!(flags & (RECURSED_CHECK | RECURSED | DIRTY | PENDING))) {
        sub.flags = flags | PENDING
        if (innerWrite) {
          sub.flags |= RECURSED
        }
      } else if (!(flags & (RECURSED_CHECK | RECURSED))) {
        flags = 0
      } else if (!(flags & RECURSED_CHECK)) {
        sub.flags = (flags & ~RECURSED) | PENDING
      } else if (!(flags & (DIRTY | PENDING)) && isValidLink(link, sub)) {
        sub.flags = flags | (RECURSED | PENDING)
        flags &= MUTABLE
      } else {
        flags = 0
      }

      if (flags & WATCHING) {
        notify(sub)
      }

      if (flags & MUTABLE) {
        const subSubs = sub.subs
        if (subSubs !== undefined) {
          link = subSubs
          const nextSub = link.nextSub
          if (nextSub !== undefined) {
            stack = { value: next, prev: stack }
            next = nextSub
          }
          continue
        }
      }

      if (next !== undefined) {
        link = next
        next = link.nextSub
        continue
      }

      while (stack !== undefined) {
        const fromStack = stack.value
        stack = stack.prev
        if (fromStack !== undefined) {
          link = fromStack
          next = link.nextSub
          continue top
        }
      }

      break
    } while (true)
  }

  function checkDirty(link: Link, sub: ReactiveNode): boolean {
    let stack: Stack<Link> | undefined
    let checkDepth = 0
    let dirty = false

    top: do {
      const dep = link.dep
      const flags = dep.flags

      if (sub.flags & DIRTY) {
        dirty = true
      } else if ((flags & (MUTABLE | DIRTY)) === (MUTABLE | DIRTY)) {
        const subs = dep.subs!
        if (update(dep)) {
          if (subs.nextSub !== undefined) {
            shallowPropagate(subs)
          }
          dirty = true
        }
      } else if ((flags & (MUTABLE | PENDING)) === (MUTABLE | PENDING)) {
        stack = { value: link, prev: stack }
        link = dep.deps!
        sub = dep
        ++checkDepth
        continue
      }

      if (!dirty) {
        const nextDep = link.nextDep
        if (nextDep !== undefined) {
          link = nextDep
          continue
        }
      }

      while (checkDepth--) {
        link = stack!.value
        stack = stack!.prev
        if (dirty) {
          const subs = sub.subs!
          if (update(sub)) {
            if (subs.nextSub !== undefined) {
              shallowPropagate(subs)
            }
            sub = link.sub
            continue
          }
          dirty = false
        } else {
          sub.flags &= ~PENDING
        }
        sub = link.sub
        const nextDep = link.nextDep
        if (nextDep !== undefined) {
          link = nextDep
          continue top
        }
      }

      return dirty && sub.flags !== 0
    } while (true)
  }

  function shallowPropagate(link: Link): void {
    let cur: Link | undefined = link
    do {
      const sub = cur.sub
      const flags = sub.flags
      if ((flags & (PENDING | DIRTY)) === PENDING) {
        sub.flags = flags | DIRTY
        if ((flags & (WATCHING | RECURSED_CHECK)) === WATCHING) {
          notify(sub)
        }
      }
      cur = cur.nextSub
    } while (cur !== undefined)
  }

  function isValidLink(checkLink: Link, sub: ReactiveNode): boolean {
    let link = sub.depsTail
    while (link !== undefined) {
      if (link === checkLink) {
        return true
      }
      link = link.prevDep
    }
    return false
  }
}
