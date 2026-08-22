# The Nonchalant wire protocol (rev 2 — draft)

Transport-agnostic (WebSocket, BroadcastChannel, in-memory, anything ordered and
reliable). Carries **state patches of plain data — never markup, never code**.
Any language can implement the host half; this file plus the conformance vectors
(`packages/wire/spec/vectors/*.json`, format in `packages/wire/spec/README.md`)
are the contract. A BEAM host certifies against the same vectors the reference
implementation runs in CI (`packages/wire/test/vectors.test.ts`).

## Messages

Client → host:

    { op: "lookup", ref, name, args }   // get-or-spawn by schema name
    { op: "send",   ref, msg }          // cast: fire-and-forget
    { op: "call",   ref, id, msg }      // ask(): correlated request
    { op: "exit",   ref }               // release; host disposes when unwatched

Host → client:

    { op: "yield",  ref, patch }        // reconcile(prev, next) since previous yield
    { op: "reply",  ref, id, value }
    { op: "done",   ref, value? }
    { op: "raise",  ref, error }

## Patch grammar

    Patch = Op[]                        // applied in order
    Op = ["set",    path, value]
       | ["del",    path]
       | ["splice", path, start, remove, insert[]]

- `path` is an RFC 6901 JSON pointer: `""` is the root, `"/items/3/done"`
  descends; `~` and `/` inside keys are escaped as `~0` and `~1`. Hosts MUST
  reject malformed escapes (`~` followed by anything other than `0` or `1`).
- Hosts MUST reject path segments `__proto__`, `constructor`, `prototype`
  (prototype pollution guard; the reference implementation is
  packages/core/src/reconcile.ts).
- The first `yield` after lookup or reconnect is a full snapshot: ops from root
  against an empty previous state. Reconnect is therefore not a special case.

## Semantics

- `lookup` is get-or-spawn against the host's **published schema** — the schema
  is simultaneously the TypeScript contract and the security whitelist. Nothing
  outside it can be spawned remotely. `args` are data.
- One `reply` per `call` id; a crashed process rejects its pending calls
  (`raise` with the id-bearing error) rather than silently retrying.
- Casts arriving while a process is restarting are retained in a bounded
  mailbox and replayed; the overflow policy is drop-oldest (a dropped call
  is rejected).
- Ordering: per-ref FIFO both directions. No cross-ref ordering guarantees.
