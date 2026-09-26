// Ambient ownership: the process whose resumption is running, so a spawn in
// that window attaches to it. Every write to the scope pointer lives here.

export interface ProcessCore {
  id: number
  children: Set<ProcessCore>
  dispose(): void
  settled(): Promise<void>
}

// Valid during the synchronous window of a process resumption (body code
// between a resume and its next await/yield). A bare spawn after an
// intervening await inside one step runs unowned; `self.spawn` doesn't read
// this pointer and is owned anywhere in the body. One extension:
// the resumption that disposal causes by closing the mailbox (see
// `resumeWithin`), so a `finally` it triggers owns what it spawns.
export let currentScope: ProcessCore | null = null

/** Run fn with `scope` as the ambient owner, restoring the previous one after,
 * throw or not. A resumption returns at the body's first await/yield, so the
 * scope covers exactly its synchronous window. */
export function withScope<T>(scope: ProcessCore | null, fn: () => T): T {
  const prev = currentScope
  currentScope = scope
  try {
    return fn()
  } finally {
    currentScope = prev
  }
}

/** Internal (registry): run fn with ambient ownership suspended — shared
 * processes must not be owned by whichever process happened to look them up. */
export function unscoped<T>(fn: () => T): T {
  return withScope(null, fn)
}

/**
 * Settle promises inside `scope`'s window: `resolve` settles promises whose
 * reactions (a parked body resuming) then run owned by `scope`. Microtasks run
 * FIFO: scope on, the reactions, scope off. Reactions queued before this call
 * run before the bracket opens.
 */
export function resumeWithin(scope: ProcessCore, resolve: () => void): void {
  void Promise.resolve().then(() => { currentScope = scope })
  resolve()
  void Promise.resolve().then(() => { currentScope = null })
}
