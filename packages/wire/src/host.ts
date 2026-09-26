// The reference host half: expose a local registry over a transport. Uses only
// the public Process face — each watched ref is one async iteration over the
// process (lossy latest is exactly right for state sync: patches are computed
// between consecutively *observed* snapshots, so they always compose).
//
// The first yield after any lookup is a full snapshot (ops against an empty
// previous state) — which is why reconnect is not a special case: the client
// re-looks-up and receives the full state as an ordinary patch.
//
// lookup goes through the registry's typed schema — the schema is the
// security whitelist; nothing outside it can be spawned remotely. Messages are
// screened before delivery: one malformed message from one client must not be
// able to crash a process every other client is watching.

import type { Json } from '@nonchalant/core'
import { encode, decodeClient, PROTOCOL, type HostMsg } from './protocol.ts'
import { errorJson, screen } from './screen.ts'
import type { Transport } from './transport.ts'
import { openWatch, type HostProcess, type Watch } from './watch.ts'

export interface Exposable {
  lookup(name: string, ...args: unknown[]): unknown
  /**
   * Screen a client message for the process looked up under `name` before it
   * is delivered: return it, or a replacement (say, with the sender stamped
   * from the session), to deliver; return undefined or throw to refuse it. A
   * refused call is rejected; a refused cast is dropped. Runs after the host's
   * own check that a message is an object with a string `type`.
   */
  admit?(name: string, msg: { type: string } & { [key: string]: Json }): Json | undefined
  /**
   * Who this session acts for. A string `callId` in a call's message is
   * rewritten into this principal's namespace before delivery, so a durable
   * callee's recorded answers are keyed per principal and one client cannot
   * read another's result by reusing its id. Omit to deliver ids untouched.
   */
  principal?: string
}

export interface ExposeOpts {
  /**
   * Cap on concurrently watched refs for this session. A lookup past the cap
   * answers with a raise instead of retaining another process; a re-lookup on
   * an existing ref replaces its watch and is always allowed. Omit for no cap.
   */
  maxWatches?: number
  /**
   * Cap on this session's lookups, as a token bucket: `max` tokens refill
   * evenly over each `perMs`, up to `burst` (default `max`) held at once, and
   * the bucket starts full. Each distinct lookup may spawn a process, so this
   * bounds how fast one session can grow the registry; a lookup with no token
   * left raises. Omit for no cap.
   */
  lookupRate?: { max: number; perMs: number; burst?: number }
}

/** Serve a registry over a transport; returns a disposer that releases every watch. */
export function expose(reg: Exposable, transport: Transport, opts?: ExposeOpts): () => void {
  const watches = new Map<string, Watch>()
  const out = (msg: HostMsg): void => transport.send(encode(msg))
  const rate = opts?.lookupRate
  // NaN or a zero window would make every refill NaN, and NaN < 1 never refuses
  if (rate !== undefined && !(Number.isInteger(rate.max) && rate.max >= 0 && rate.perMs > 0 && Number.isInteger(rate.burst ?? rate.max) && (rate.burst ?? rate.max) >= 0))
    throw new Error('nonchalant/wire: lookupRate needs non-negative integer max and burst and a positive perMs')
  let tokens = rate?.burst ?? rate?.max ?? 0
  let refilledAt = Date.now()

  const stopWatch = (ref: string): void => {
    const w = watches.get(ref)
    if (w === undefined) return
    watches.delete(ref)
    w.stop()
  }

  const refuseLookup = (v: unknown): string | undefined => {
    if (v !== PROTOCOL) return `protocol mismatch: host speaks ${PROTOCOL}, lookup carried ${JSON.stringify(v ?? null)}`
    if (opts?.maxWatches !== undefined && watches.size >= opts.maxWatches) return 'watch limit reached'
    if (rate !== undefined) {
      const now = Date.now()
      // a clock that steps back refills nothing
      tokens = Math.min(rate.burst ?? rate.max, tokens + (Math.max(0, now - refilledAt) * rate.max) / rate.perMs)
      refilledAt = now
      if (tokens < 1) return 'lookup rate exceeded'
      tokens--
    }
    return undefined
  }

  // the watch's own end (done or raise) is reported only while it is still the ref's current watch
  const finish = (ref: string) => (w: Watch, last: HostMsg): void => {
    if (watches.get(ref) !== w) return
    out(last)
    watches.delete(ref)
  }

  const startWatch = (ref: string, name: string, args: unknown, v: unknown): void => {
    stopWatch(ref) // re-lookup on an existing ref restarts from a full snapshot
    let proc: HostProcess
    try {
      const refused = refuseLookup(v)
      if (refused !== undefined) throw new Error(refused)
      proc = (args === undefined ? reg.lookup(name) : reg.lookup(name, args)) as HostProcess
    } catch (e) {
      out({ op: 'raise', ref, error: errorJson(e) })
      return
    }
    watches.set(ref, openWatch(ref, name, proc, out, finish(ref)))
  }

  const stopAll = (): void => {
    for (const ref of [...watches.keys()]) stopWatch(ref)
  }

  const unsubscribe = transport.subscribe({
    message: (data) => {
      const msg = decodeClient(data)
      if (msg === null) return // not ours (bus transport chatter) or garbage
      switch (msg.op) {
        case 'lookup':
          startWatch(msg.ref, msg.name, msg.args, msg.v)
          return
        case 'cast': {
          const w = watches.get(msg.ref)
          if (w === undefined || w.proc.cast === undefined) return // fire-and-forget: nowhere to report
          const m = screen(msg.msg, w.name, reg)
          if (!(m instanceof Error)) w.proc.cast(m)
          return
        }
        case 'call': {
          const { ref, id } = msg
          const w = watches.get(ref)
          const m = w === undefined ? new Error('no such process') : screen(msg.msg, w.name, reg)
          if (m instanceof Error || w?.proc.call === undefined) {
            out({ op: 'raise', ref, error: errorJson(m instanceof Error ? m : new Error('not callable'), id) })
            return
          }
          w.proc.call(m).then(
            (value) => out({ op: 'reply', ref, id, value: value as Json }),
            (e) => out({ op: 'raise', ref, error: errorJson(e, id) }),
          )
          return
        }
        case 'exit':
          stopWatch(msg.ref) // releases this watch; registry refcounting decides disposal
          return
      }
    },
    close: stopAll,
  })

  return () => {
    stopAll()
    unsubscribe()
  }
}
