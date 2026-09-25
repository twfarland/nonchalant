// connect(transport) returns a Registry — the same interface as a local one
// (a name resolves identically at every distance; docs/concepts.md, "Wire").
//
// Each remote ref is a local *pump* process: host messages land in its
// mailbox, patches apply to a running snapshot, and every application is a
// yield — so the full Process face (sync reads with path-precise tracking,
// pending/stale/error, lossy iteration, dispose) is the ordinary local
// machinery. A process-level raise crashes the pump (readers keep the last
// value, stale: true); the pump restarts and waits, and the reconnect
// re-lookup delivers a full snapshot that diffs against the retained value —
// readers of unchanged paths sleep straight through the reconnect.
//
// cast/call on the facade are overridden to wire ops; pending calls reject on
// raise, done, disconnect, and dispose, and a call made while disconnected
// rejects immediately — the transport would drop it and no replay exists.
// Casts made while disconnected queue per ref (bounded, drop-oldest) and are
// sent right after the re-lookup, so they reach the fresh watch in order.
// Isomorphic and DOM-free.

import { applyPatch, spawn } from '@nonchalant/core'
import type { Definition, Json, Proc, Process, Registry, Self } from '@nonchalant/core'
import { encode, decodeHost, PROTOCOL, type ClientMsg, type HostMsg } from './protocol.ts'
import type { Transport } from './transport.ts'

export class WireError extends Error {
  readonly detail: Json
  constructor(detail: Json) {
    const message =
      typeof detail === 'object' && detail !== null && !Array.isArray(detail) && typeof detail['message'] === 'string'
        ? detail['message']
        : String(detail)
    super(message)
    this.name = 'WireError'
    this.detail = detail
  }
}

const canon = (v: unknown): unknown => {
  if (typeof v !== 'object' || v === null) return v
  if (Array.isArray(v)) return v.map(canon)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v).sort()) out[k] = canon((v as Record<string, unknown>)[k])
  return out
}

const pumpProc: Proc<Json, HostMsg, void> = async function* (self: Self<HostMsg>) {
  let snapshot: Json = null
  for await (const m of self) {
    if (m.op === 'yield') {
      snapshot = applyPatch(snapshot, m.patch) // first patch is a full snapshot: ops against the root
      yield snapshot
    } else if (m.op === 'done') {
      return
    } else if (m.op === 'raise') {
      throw new WireError(m.error)
    }
  }
}

/** Casts retained per ref while disconnected; past this the oldest is dropped. */
const CAST_QUEUE = 64

interface Call {
  resolve(value: Json | undefined): void
  reject(err: unknown): void
}

interface Entry {
  ref: string
  key: string
  name: string
  args: Json | undefined
  facade: Process<unknown, unknown>
  /** the pump's original mailbox cast, captured before the facade's cast is overridden */
  deliver(msg: HostMsg): void
  calls: Map<number, Call>
  queued: Json[]
  dead: boolean
}

export interface Connection<S extends { [K in keyof S]: Definition<unknown, unknown, unknown> }>
  extends Registry<S> {
  /** Tear down: dispose every remote facade and release the transport. */
  close(): void
}

export function connect<S extends { [K in keyof S]: Definition<unknown, unknown, unknown> }>(
  transport: Transport,
): Connection<S> {
  const session =
    (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID?.() ??
    Math.random().toString(36).slice(2)
  const entries = new Map<string, Entry>()
  const byRef = new Map<string, Entry>()
  let refN = 0
  let callN = 0
  let connected = false

  const out = (msg: ClientMsg): void => transport.send(encode(msg))

  const rejectCalls = (entry: Entry, err: unknown): void => {
    for (const call of entry.calls.values()) call.reject(err)
    entry.calls.clear()
  }

  // terminal for this facade; its name resolves afresh on the next lookup,
  // as a local registry forgets a settled entry
  const end = (entry: Entry, why: string): void => {
    entry.dead = true
    entry.queued = []
    if (entries.get(entry.key) === entry) entries.delete(entry.key)
    byRef.delete(entry.ref)
    rejectCalls(entry, new WireError({ message: why }))
  }

  const sendLookup = (entry: Entry): void => {
    out(
      entry.args === undefined
        ? { op: 'lookup', ref: entry.ref, name: entry.name, v: PROTOCOL }
        : { op: 'lookup', ref: entry.ref, name: entry.name, v: PROTOCOL, args: entry.args },
    )
    for (const msg of entry.queued.splice(0)) out({ op: 'cast', ref: entry.ref, msg })
  }

  const unsubscribe = transport.subscribe({
    message: (data) => {
      const m = decodeHost(data)
      if (m === null) return // not ours (bus chatter) or garbage
      const entry = byRef.get(m.ref)
      if (entry === undefined) return
      switch (m.op) {
        case 'reply': {
          const call = entry.calls.get(m.id)
          if (call !== undefined) {
            entry.calls.delete(m.id)
            call.resolve(m.value)
          }
          return
        }
        case 'raise': {
          const err = m.error
          const id =
            typeof err === 'object' && err !== null && !Array.isArray(err) && typeof err['id'] === 'number'
              ? err['id']
              : undefined
          if (id !== undefined) {
            const call = entry.calls.get(id)
            if (call !== undefined) {
              entry.calls.delete(id)
              call.reject(new WireError(err))
            }
            return
          }
          rejectCalls(entry, new WireError(err)) // a crashed process rejects its pending calls
          entry.deliver(m)
          return
        }
        case 'done':
          end(entry, 'process ended')
          entry.deliver(m)
          return
        case 'yield':
          entry.deliver(m)
          return
      }
    },
    open: () => {
      connected = true
      for (const entry of byRef.values()) if (!entry.dead) sendLookup(entry) // reconnect = re-lookup; full patch follows
    },
    close: () => {
      connected = false
      for (const entry of byRef.values()) {
        rejectCalls(entry, new WireError({ message: 'transport disconnected' }))
        if (!entry.dead)
          entry.deliver({ op: 'raise', ref: entry.ref, error: { message: 'transport disconnected' } })
      }
    },
  })

  const lookup = (name: string, ...rest: unknown[]): Process<unknown, unknown> => {
    const args = rest[0] as Json | undefined
    const key = name + '\0' + (args === undefined ? '' : JSON.stringify(canon(args)))
    const existing = entries.get(key)
    if (existing !== undefined) return existing.facade
    const ref = `${session}:${++refN}`
    // infinite, quiet restarts: each raise crashes the pump (stale reads, not an
    // onProcessError report — a disconnect is not a bug), each
    // reconnect re-lookup feeds the fresh instance a full snapshot
    const facade = spawn(pumpProc, undefined, { restart: 'on-crash', maxRestarts: Number.POSITIVE_INFINITY, quiet: true })
    const withMailbox = facade as unknown as { cast(m: HostMsg): void }
    const deliver = withMailbox.cast.bind(facade)
    const entry: Entry = { ref, key, name, args, facade: facade as Process<unknown, unknown>, deliver, calls: new Map(), queued: [], dead: false }
    entries.set(key, entry)
    byRef.set(ref, entry)

    const face = facade as unknown as Record<PropertyKey, unknown>
    face['cast'] = (msg: Json): void => {
      if (entry.dead) return
      if (connected) out({ op: 'cast', ref, msg })
      else if (entry.queued.push(msg) > CAST_QUEUE) entry.queued.shift()
    }
    face['call'] = (msg: Json): Promise<Json | undefined> =>
      new Promise((resolve, reject) => {
        if (entry.dead) {
          reject(new WireError({ message: 'process ended' }))
          return
        }
        if (!connected) {
          reject(new WireError({ message: 'transport disconnected' }))
          return
        }
        const id = ++callN
        entry.calls.set(id, { resolve, reject })
        out({ op: 'call', ref, id, msg })
      })
    const innerDispose = face[Symbol.dispose] as () => void
    const innerAsyncDispose = face[Symbol.asyncDispose] as () => Promise<void>
    const dispose = (): void => {
      if (!entry.dead) {
        entry.dead = true
        if (connected) out({ op: 'exit', ref })
      }
      end(entry, 'process disposed')
      innerDispose()
    }
    face[Symbol.dispose] = dispose
    face[Symbol.asyncDispose] = async (): Promise<void> => {
      dispose()
      await innerAsyncDispose()
    }

    if (connected) sendLookup(entry)
    return entry.facade
  }

  const close = (): void => {
    for (const entry of [...byRef.values()]) (entry.facade as unknown as Disposable)[Symbol.dispose]()
    unsubscribe()
  }

  return { lookup, close } as unknown as Connection<S>
}
