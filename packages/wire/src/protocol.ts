// The wire protocol, rev 2 (docs/PROTOCOL.md): eight ops, JSON on an ordered
// reliable transport, state patches of plain data — never markup, never code.
// This module is the codec: encode/decode with structural validation. It is
// deliberately boring — it doubles as the reference vocabulary for non-JS
// hosts, which certify against packages/wire/spec/vectors/*.json.
// Isomorphic and DOM-free.

import type { Json, Patch } from '@nonchalant/core'

/** client → host */
export type ClientMsg =
  | { op: 'lookup'; ref: string; name: string; args?: Json }
  | { op: 'send'; ref: string; msg: Json }
  | { op: 'call'; ref: string; id: number; msg: Json }
  | { op: 'exit'; ref: string }

/** host → client */
export type HostMsg =
  | { op: 'yield'; ref: string; patch: Patch }
  | { op: 'reply'; ref: string; id: number; value: Json }
  | { op: 'done'; ref: string; value?: Json }
  /** Process-level failure, or — when `error` carries an `id` — rejection of that pending call. */
  | { op: 'raise'; ref: string; error: Json }

export const encode = (msg: ClientMsg | HostMsg): string => JSON.stringify(msg)

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// values need no deep check: JSON.parse output is JSON-shaped by construction
const isPatch = (v: unknown): v is Patch =>
  Array.isArray(v) &&
  v.every(
    (op) =>
      Array.isArray(op) &&
      typeof op[1] === 'string' &&
      (op[1] === '' || op[1].startsWith('/')) &&
      ((op[0] === 'set' && op.length === 3) ||
        (op[0] === 'del' && op.length === 2) ||
        (op[0] === 'splice' &&
          op.length === 5 &&
          Number.isInteger(op[2]) &&
          Number.isInteger(op[3]) &&
          (op[2] as number) >= 0 &&
          (op[3] as number) >= 0 &&
          Array.isArray(op[4]))),
  )

/** Decode a client→host message; null if this is not one (wrong direction or garbage). */
export function decodeClient(data: string): ClientMsg | null {
  let v: unknown
  try {
    v = JSON.parse(data)
  } catch {
    return null
  }
  if (!isRecord(v) || typeof v['ref'] !== 'string') return null
  switch (v['op']) {
    case 'lookup':
      return typeof v['name'] === 'string' ? (v as ClientMsg) : null
    case 'send':
      return 'msg' in v ? (v as ClientMsg) : null
    case 'call':
      return typeof v['id'] === 'number' && 'msg' in v ? (v as ClientMsg) : null
    case 'exit':
      return v as ClientMsg
    default:
      return null
  }
}

/** Decode a host→client message; null if this is not one (wrong direction or garbage). */
export function decodeHost(data: string): HostMsg | null {
  let v: unknown
  try {
    v = JSON.parse(data)
  } catch {
    return null
  }
  if (!isRecord(v) || typeof v['ref'] !== 'string') return null
  switch (v['op']) {
    case 'yield':
      return isPatch(v['patch']) ? (v as HostMsg) : null
    case 'reply':
      return typeof v['id'] === 'number' && 'value' in v ? (v as HostMsg) : null
    case 'done':
      return v as HostMsg
    case 'raise':
      return 'error' in v ? (v as HostMsg) : null
    default:
      return null
  }
}
