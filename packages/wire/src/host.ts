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
// security whitelist; nothing outside it can be spawned remotely.

import { reconcile } from '@nonchalant/core'
import type { Json, ProcessBase } from '@nonchalant/core'
import { encode, decodeClient, type HostMsg } from './protocol.ts'
import type { Transport } from './transport.ts'

interface HostProcess extends ProcessBase<unknown> {
  cast?(msg: unknown): void
  call?(msg: unknown): Promise<unknown>
}

export interface Exposable {
  lookup(name: string, ...args: unknown[]): unknown
}

export interface ExposeOpts {
  /**
   * Cap on concurrently watched refs for this session. A lookup past the cap
   * answers with a raise instead of retaining another process; a re-lookup on
   * an existing ref replaces its watch and is always allowed. Omit for no cap.
   */
  maxWatches?: number
}

interface Watch {
  proc: HostProcess
  stop(): void
}

/** Serve a registry over a transport; returns a disposer that releases every watch. */
export function expose(reg: Exposable, transport: Transport, opts?: ExposeOpts): () => void {
  const watches = new Map<string, Watch>()
  const out = (msg: HostMsg): void => transport.send(encode(msg))

  const errorJson = (e: unknown, id?: number): Json => {
    const base: { message: string; id?: number } = { message: e instanceof Error ? e.message : String(e) }
    if (id !== undefined) base.id = id
    return base as Json
  }

  const stopWatch = (ref: string): void => {
    const w = watches.get(ref)
    if (w === undefined) return
    watches.delete(ref)
    w.stop()
  }

  const startWatch = (ref: string, name: string, args: unknown): void => {
    stopWatch(ref) // re-lookup on an existing ref restarts from a full snapshot
    if (opts?.maxWatches !== undefined && watches.size >= opts.maxWatches) {
      out({ op: 'raise', ref, error: errorJson(new Error('watch limit reached')) })
      return
    }
    let proc: HostProcess
    try {
      proc = (args === undefined ? reg.lookup(name) : reg.lookup(name, args)) as HostProcess
    } catch (e) {
      out({ op: 'raise', ref, error: errorJson(e) })
      return
    }
    const it = proc[Symbol.asyncIterator]()
    let active = true
    const watch: Watch = {
      proc,
      stop: () => {
        active = false
        void it.return?.()
      },
    }
    watches.set(ref, watch)
    void (async () => {
      let prev: Json | undefined
      try {
        while (active) {
          const r = await it.next()
          if (r.done) break
          const cur = r.value as Json
          const patch = reconcile(prev as Json, cur) // prev undefined on the first pass → full snapshot
          prev = cur
          if (patch.length > 0) out({ op: 'yield', ref, patch })
        }
        if (active && watches.get(ref) === watch) {
          if (proc.error !== undefined) out({ op: 'raise', ref, error: errorJson(proc.error) })
          else out({ op: 'done', ref })
          watches.delete(ref)
        }
      } catch (e) {
        if (active && watches.get(ref) === watch) {
          out({ op: 'raise', ref, error: errorJson(e) })
          watches.delete(ref)
        }
      }
    })()
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
          startWatch(msg.ref, msg.name, msg.args)
          return
        case 'cast':
          watches.get(msg.ref)?.proc.cast?.(msg.msg)
          return
        case 'call': {
          const w = watches.get(msg.ref)
          const { ref, id } = msg
          if (w === undefined || w.proc.call === undefined) {
            out({ op: 'raise', ref, error: errorJson(new Error('no such process'), id) })
            return
          }
          w.proc.call(msg.msg).then(
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
