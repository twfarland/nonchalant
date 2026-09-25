// The wire protocol, rev 3 (docs/PROTOCOL.md): eight ops, JSON on an ordered
// reliable transport, state patches of plain data — never markup, never code.
// This module is the codec: encode/decode with structural validation. It is
// deliberately boring — it doubles as the reference vocabulary for non-JS
// hosts, which certify against packages/wire/spec/vectors/*.json.
// Isomorphic and DOM-free.

import type { Json, Patch } from '@nonchalant/core'

/** The revision this codec speaks; every lookup carries it as `v`. */
export const PROTOCOL = 3

/** client → host. An absent `msg` is a message with no value (JS `undefined`). */
export type ClientMsg =
  | { op: 'lookup'; ref: string; name: string; v: number; args?: Json }
  | { op: 'cast'; ref: string; msg?: Json }
  | { op: 'call'; ref: string; id: number; msg?: Json }
  | { op: 'exit'; ref: string }

/** host → client. An absent `value` is a reply or result with no value (JS `undefined`). */
export type HostMsg =
  | { op: 'yield'; ref: string; patch: Patch }
  | { op: 'reply'; ref: string; id: number; value?: Json }
  | { op: 'done'; ref: string; value?: Json }
  /** Process-level failure, or — when `error` carries an `id` — rejection of that pending call. */
  | { op: 'raise'; ref: string; error: Json }

export const encode = (msg: ClientMsg | HostMsg): string => JSON.stringify(msg)

export const isRecord = (v: unknown): v is Record<string, unknown> =>
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

const parse = (data: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(data)
    return isRecord(v) && typeof v['ref'] === 'string' ? v : null
  } catch {
    return null
  }
}

/**
 * Decode a client→host message; null if this is not one (wrong direction or
 * garbage). A lookup's `v` is not checked here: the host answers a mismatch
 * with a raise, which a silent drop could not.
 */
export function decodeClient(data: string): ClientMsg | null {
  const v = parse(data)
  if (v === null) return null
  switch (v['op']) {
    case 'lookup':
      return typeof v['name'] === 'string' ? (v as ClientMsg) : null
    case 'call':
      return Number.isSafeInteger(v['id']) ? (v as ClientMsg) : null
    case 'cast':
    case 'exit':
      return v as ClientMsg
    default:
      return null
  }
}

/** Decode a host→client message; null if this is not one (wrong direction or garbage). */
export function decodeHost(data: string): HostMsg | null {
  const v = parse(data)
  if (v === null) return null
  switch (v['op']) {
    case 'yield':
      return isPatch(v['patch']) ? (v as HostMsg) : null
    case 'reply':
      return Number.isSafeInteger(v['id']) ? (v as HostMsg) : null
    case 'done':
      return v as HostMsg
    case 'raise':
      return 'error' in v ? (v as HostMsg) : null
    default:
      return null
  }
}
