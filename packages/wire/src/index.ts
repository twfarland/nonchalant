// @nonchalant/wire — protocol types (rev 2, draft 3 §06). Runtime lands at M6.
// Patch/Op live in @nonchalant/core (reconcile is the local update path too);
// re-exported here once cross-package build wiring lands (ROADMAP M6).
// This module must remain isomorphic and DOM-free: it doubles as the spec's
// reference vocabulary for non-JS hosts.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Op =
  | ['set', path: string, value: Json]
  | ['del', path: string]
  | ['splice', path: string, start: number, remove: number, insert: Json[]]
type Patch = Op[]

/** client → host */
export type ClientMsg =
  | { op: 'lookup'; ref: string; name: string; args: Json }
  | { op: 'send'; ref: string; msg: Json }
  | { op: 'call'; ref: string; id: number; msg: Json }
  | { op: 'exit'; ref: string }

/** host → client */
export type HostMsg =
  | { op: 'yield'; ref: string; patch: Patch }
  | { op: 'reply'; ref: string; id: number; value: Json }
  | { op: 'done'; ref: string; value?: Json }
  | { op: 'raise'; ref: string; error: Json }
