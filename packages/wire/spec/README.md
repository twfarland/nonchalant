# Wire conformance vectors

These JSON files are the language-agnostic contract for protocol rev 3
(docs/PROTOCOL.md). A host implementation in any language certifies by running
them; the reference (Node) implementation runs them in CI
(`packages/wire/test/vectors.test.ts`). A BEAM host certifies against the
same files.

## patches.json

`patches.json` defines the required behavior of `applyPatch(prev, patch)`. The
file contains an envelope around the cases:

```json
{ "description": "...", "cases": [ <case>, ... ] }
```

Each case is one of:

```json
{ "name": "...", "prev": <Json>, "patch": [<Op>...], "next": <Json> }
{ "name": "...", "prev": <Json>, "patch": [<Op>...], "error": true }
```

- Ops: `["set", path, value]`, `["del", path]`,
  `["splice", path, start, remove, insert[]]`, applied in order, pure.
- Paths are RFC 6901 JSON pointers (`~0` → `~`, `~1` → `/`; `""` is the root).
- Every JSON key is valid, including `__proto__`, `constructor`, and
  `prototype`; implementations MUST create own data properties without invoking
  prototype setters.
- An array index segment MUST match RFC 6901's grammar, `0|[1-9][0-9]*`, and
  name an existing element: no sign, leading zero, exponent, fraction,
  whitespace, or empty segment. `-` is not an index here — appends are
  splices.
- Absent and undefined are one state. JSON cannot carry `undefined`, but a
  producer whose language has it (the JS reference) never emits a `set` for a
  record key holding it, emits `del` when a key goes to it, and applies a
  `set` whose value is `undefined` as removal of that key. Nothing crosses the
  wire differently; the rule only keeps local diff and apply symmetric, so it
  has no vector.
- `error: true` cases MUST be rejected: malformed escapes, paths that are
  neither `""` nor `/`-prefixed, non-integer or negative splice numbers,
  invalid array indices/ranges, splices on non-arrays, `del` of the root or
  of a missing key, and paths that descend through a primitive or a missing
  key. Rejecting means
  refusing the entire patch rather than applying a prefix. Rejection may happen at
  either layer. The reference codec refuses unprefixed paths and bad splice
  numbers at decode time (`decodeHost` returns null) and the rest at apply
  time, but a malformed patch MUST NOT be applied.

## session-*.json

Scripted host sessions over the canonical **counter** process. Each file is an
envelope holding the ordered steps, and optionally the host limits the session
runs under:

```json
{ "description": "...", "host": { "maxWatches": 1 }, "steps": [ <step>, ... ] }
```

Every certifying host implements the counter from this description:

- schema name `"counter"`, args `{ "start": number }`
- state: `{ "n": number }`, first yield is the full initial state
- cast `{ "type": "add", "n": number }` → adds and yields
- cast `{ "type": "stop" }` → the process returns (the host sends `done`)
- cast `{ "type": "crash" }` → the process throws (the host sends a raise without an id)
- call `{ "type": "get" }` → replies `{ "n": number }` (no state change, no yield)
- call `{ "type": "reset" }` → replies `{ "n": <before> }`, sets `n` to 0, and yields
- call `{ "type": "echo", "value"?: Json }` → replies with `value`, or with no
  value when it is absent (no yield)

A host whose schema is keyed by name and args (as the reference registry is)
resolves two lookups with equal args to one process, and a lookup after that
process ended or crashed to a fresh one.

Step forms:

```json
{ "recv": <any JSON> }                        // deliver to the host verbatim
{ "expect": "yield", "ref": "...", "state": <Json> }  // a yield must arrive; applying its
                                              // patch to the running state gives `state`
                                              // (patch bytes are host's choice)
{ "expect": <HostMsg> }                       // exact message match (reply/done)
{ "expect": "raise", "ref": "...", "id": n }  // a raise rejecting call n (error.id === n)
{ "expect": "raise", "ref": "..." }           // a process-level raise (error has no id)
{ "unordered": [ <expect step>, ... ] }       // the next N messages match these, in any order
```

Ordering is per-ref FIFO. Yields assert resulting state, not patch bytes,
because a host may diff differently; replies are exact. The first yield after
any lookup, including a re-lookup after reconnect, must be a full snapshot:
ops against an empty previous state. A yield step with `"full": true`
additionally asserts that property: the patch must reconstruct `state` when
applied to nothing. After the last step, no further message may arrive; a
`recv` that must produce nothing is followed directly by the next expectation,
so a stray message fails it.

## Rules the vectors pin down

These are part of the contract (docs/PROTOCOL.md states them in prose):

- **Version.** Every `lookup` carries `"v": 3`. A lookup without it or with any
  other value is answered with a process-level raise and the ref is not
  watched (`session-version.json`).
- **Call ids** are safe integers (|id| ≤ 2^53 − 1); a decoder drops a call or
  reply whose id is not one. An id must be unique among the in-flight calls on
  its ref; it may be reused once answered. The reference client counts up from
  1 per connection, so its ids are unique per connection.
- **Absent values.** `cast.msg`, `call.msg`, `reply.value`, and `done.value`
  may be absent, meaning "no value" (JS `undefined`); `null` is a value
  (`session-values.json`).
- **Delivery screening.** Hosts deliver only messages that are objects with a
  string `type`. Anything else is refused before it reaches the process: a
  refused call raises with its id, a refused cast is dropped
  (`session-call-errors.json`). Hosts may refuse more (the reference host's
  `admit`).
- **Before lookup, after exit.** A cast to a ref that is not watched is dropped
  silently; a call to one raises with its id.
- **`done` is terminal** for the ref: no further messages arrive for it; a
  later lookup on the same ref starts a new watch (`session-done.json`). A
  process-level raise ends the watch the same way (`session-crash.json`).
- **Two refs, one process** are two independent watches; cross-ref order is
  unspecified (`session-two-refs.json`).
- **Replies are not ordered against yields.** A call's reply may arrive before
  or after the yield its handling caused (`session-reply-order.json`).
- **Refused lookups** (unknown name, watch cap, rate cap, version) raise
  without an id and leave the ref unwatched (`session-relookup.json`,
  `session-watch-cap.json`).
- **Message size** is a host limit, not a protocol constant. The reference
  Node host accepts up to 1 MiB per client message by default and closes the
  connection with WebSocket code 1009 above it.
