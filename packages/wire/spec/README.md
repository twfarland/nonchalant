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
envelope holding the ordered steps:

```json
{ "description": "...", "steps": [ <step>, ... ] }
```

Every certifying host implements the counter from this description:

- schema name `"counter"`, args `{ "start": number }`
- state: `{ "n": number }`, first yield is the full initial state
- cast `{ "type": "add", "n": number }` → adds and yields
- call `{ "type": "get" }` → replies `{ "n": number }` (no state change, no yield)

Step forms:

```json
{ "recv": <ClientMsg> }                       // deliver to the host
{ "expect": "yield", "ref": "...", "state": <Json> }  // a yield must arrive; applying its
                                              // patch to the running state gives `state`
                                              // (patch bytes are host's choice)
{ "expect": <HostMsg> }                       // exact message match (reply/done)
{ "expect": "raise", "ref": "..." }           // a raise for the ref (error body free-form)
```

Ordering is per-ref FIFO. Yields assert resulting state, not patch bytes,
because a host may diff differently; replies are exact. The first yield after
any lookup, including a re-lookup after reconnect, must be a full snapshot:
ops against an empty previous state. A yield step with `"full": true`
additionally asserts that property: the patch must reconstruct `state` when
applied to nothing.
