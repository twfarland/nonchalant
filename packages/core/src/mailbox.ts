// The mailbox: a FIFO queue of messages plus a FIFO of parked takers, and
// the `Self` face a generator iterates. `channel` is the same mailbox without
// a process around it.

import type { Self } from './types.ts'

// ---------- fifo ----------

// FIFO with a moving head: O(1) amortized shift where Array#shift is O(n) at
// depth. Compacts once the consumed prefix is at least half the array.
export class Fifo<T> {
  private items: (T | undefined)[] = []
  private head = 0

  size(): number {
    return this.items.length - this.head
  }

  push(v: T): void {
    this.items.push(v)
  }

  peek(): T | undefined {
    return this.items[this.head]
  }

  shift(): T {
    const v = this.items[this.head] as T
    this.items[this.head++] = undefined // release for gc before compaction
    if (this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head)
      this.head = 0
    }
    return v
  }

  drain(): T[] {
    const rest = this.items.slice(this.head) as T[]
    this.items = []
    this.head = 0
    return rest
  }
}

// ---------- mailbox ----------

export interface MailboxHooks<In> {
  bound?: number | undefined
  onDrop?: (msg: In) => void
  onDeliver?: () => void
  onIdle?: () => void
}

interface Taker<In> {
  resolve: (r: IteratorResult<In>) => void
  latest: boolean
}

export class Mailbox<In> {
  readonly queue = new Fifo<In>()
  private takers = new Fifo<Taker<In>>()
  private warned = false
  private drainScheduled = false
  private hooks: MailboxHooks<In>
  closed = false

  // no parameter property: the package ships erasable-syntax-only TS
  constructor(hooks: MailboxHooks<In>) {
    this.hooks = hooks
  }

  push(msg: In): void {
    if (this.closed) {
      this.hooks.onDrop?.(msg)
      return
    }
    const head = this.takers.peek()
    if (head !== undefined && !head.latest) {
      this.deliver(msg)
      return
    }
    this.queue.push(msg)
    // a waiting latest() taker gets the newest of the burst, not the first:
    // defer delivery one microtask so same-tick casts can supersede
    if (head !== undefined) this.scheduleDrain()
    const bound = this.hooks.bound
    if (bound !== undefined && this.queue.size() > bound) {
      const dropped = this.queue.shift()
      if (!this.warned) {
        this.warned = true
        console.warn(`nonchalant: mailbox overflow (bound ${bound}) — dropping oldest message`)
      }
      this.hooks.onDrop?.(dropped)
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return
    this.drainScheduled = true
    Promise.resolve().then(() => {
      this.drainScheduled = false
      const head = this.takers.peek()
      if (this.closed || this.queue.size() === 0 || head === undefined || !head.latest) return
      this.deliver(this.drainToNewest())
    })
  }

  // hand msg to the head taker, which the caller has checked is parked
  private deliver(msg: In): void {
    const taker = this.takers.shift()
    this.hooks.onDeliver?.()
    taker.resolve({ value: msg, done: false })
  }

  private drainToNewest(): In {
    const all = this.queue.drain()
    const msg = all.pop() as In
    for (const dropped of all) this.hooks.onDrop?.(dropped)
    return msg
  }

  take(latest: boolean): Promise<IteratorResult<In>> {
    if (this.queue.size() > 0) {
      const msg = latest ? this.drainToNewest() : this.queue.shift()
      this.hooks.onDeliver?.()
      return Promise.resolve({ value: msg, done: false })
    }
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
    this.hooks.onIdle?.()
    return new Promise((resolve) => this.takers.push({ resolve, latest }))
  }

  /** `wrap` runs around the resolution of parked takers (process: resume in scope). */
  close(wrap = (resolveTakers: () => void): void => resolveTakers()): void {
    if (this.closed) return
    this.closed = true
    const takers = this.takers.drain()
    wrap(() => {
      for (const taker of takers) taker.resolve({ value: undefined as never, done: true })
    })
    for (const msg of this.queue.drain()) this.hooks.onDrop?.(msg)
  }
}

// ---------- self ----------

export const selfFor = <In>(mailbox: Mailbox<In>, signal: AbortSignal, cast: (msg: In) => void): Self<In> => ({
  signal,
  cast,
  [Symbol.asyncIterator]: (): AsyncIterator<In> => ({ next: () => mailbox.take(false) }),
  latest: (): AsyncIterable<In> => ({
    [Symbol.asyncIterator]: (): AsyncIterator<In> => ({ next: () => mailbox.take(true) }),
  }),
})

/**
 * A standalone Self — a private mailbox for wrapping or testing processes
 * (middleware hands one to an inner proc). Iteration ends when `signal` aborts
 * or the channel is disposed.
 */
export function channel<In>(signal?: AbortSignal): Self<In> & Disposable {
  const mailbox = new Mailbox<In>({})
  const controller = signal === undefined ? new AbortController() : undefined
  const sig = signal ?? controller!.signal
  if (signal !== undefined) {
    if (signal.aborted) mailbox.close()
    else signal.addEventListener('abort', () => mailbox.close(), { once: true })
  }
  return Object.assign(selfFor(mailbox, sig, (msg) => mailbox.push(msg)), {
    [Symbol.dispose]: (): void => {
      controller?.abort()
      mailbox.close()
    },
  })
}
