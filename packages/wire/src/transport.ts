// Transports carry opaque strings over anything ordered and reliable.
// The in-memory pair is the reference implementation and the test rig —
// it can partition and heal, which is how reconnect-as-full-patch is proven.

export interface TransportHandlers {
  message(data: string): void
  /** The transport (re)connected. connect() re-issues lookups here. */
  open?(): void
  /** The transport dropped. connect() marks entries stale here. */
  close?(): void
}

export interface Transport {
  send(data: string): void
  /** Register handlers; returns an unsubscribe. If already connected, `open` fires (async) on subscribe. */
  subscribe(handlers: TransportHandlers): () => void
}

interface End {
  handlers: TransportHandlers | null
  queue: string[]
}

export interface MemoryLink {
  client: Transport
  host: Transport
  /** Partition: in-flight and future messages are dropped; both ends see close. */
  disconnect(): void
  /** Heal: both ends see open; the client is expected to re-lookup. */
  reconnect(): void
  /** Await delivery of everything currently in flight. */
  settle(): Promise<void>
}

/** An in-memory transport pair with controllable partitions (async, ordered, lossless while connected). */
export function memoryPair(): MemoryLink {
  let connected = true
  const a: End = { handlers: null, queue: [] } // client end
  const b: End = { handlers: null, queue: [] } // host end
  let pending = 0
  let settlers: (() => void)[] = []

  const deliver = (to: End, data: string): void => {
    if (!connected) return
    pending++
    queueMicrotask(() => {
      pending--
      if (connected && to.handlers !== null) to.handlers.message(data)
      if (pending === 0) {
        const done = settlers
        settlers = []
        for (const s of done) s()
      }
    })
  }

  const makeEnd = (self: End, other: End): Transport => ({
    send: (data) => deliver(other, data),
    subscribe: (handlers) => {
      self.handlers = handlers
      if (connected) queueMicrotask(() => handlers.open?.())
      return () => {
        if (self.handlers === handlers) self.handlers = null
      }
    },
  })

  return {
    client: makeEnd(a, b),
    host: makeEnd(b, a),
    disconnect: () => {
      if (!connected) return
      connected = false
      a.handlers?.close?.()
      b.handlers?.close?.()
    },
    reconnect: () => {
      if (connected) return
      connected = true
      a.handlers?.open?.()
      b.handlers?.open?.()
    },
    settle: () =>
      pending === 0
        ? Promise.resolve()
        : new Promise((resolve) => settlers.push(resolve)),
  }
}
