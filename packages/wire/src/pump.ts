// The local stand-in for one remote ref: host messages land in its mailbox,
// patches apply to a running snapshot, and every application is a yield — so
// the full Process face is the ordinary local machinery. A raise crashes it
// (readers keep the last value, stale: true); done ends it.

import { applyPatch } from '@nonchalant/core'
import type { Json, Proc, Self } from '@nonchalant/core'
import type { HostMsg } from './protocol.ts'

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

export const pumpProc: Proc<Json, HostMsg, void> = async function* (self: Self<HostMsg>) {
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
