# Wire conformance vectors

These JSON files are the language-agnostic contract for protocol rev 2
(docs/PROTOCOL.md). A host implementation in any language certifies by running
them; the reference (Node) implementation runs them in CI
(`packages/wire/test/vectors.test.ts`). A BEAM host certifies against the
same files.

## patches.json

Patch-application semantics — what `applyPatch(prev, patch)` must do:

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
- `error: true` cases MUST be rejected: malformed escapes, invalid array
  indices/ranges, and splices on non-arrays. Rejecting means refusing the patch
  — not applying a prefix of it.

## session-*.json

Scripted host sessions over the canonical **counter** process, which every
certifying host implements from this description:

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
any lookup — including a re-lookup after reconnect — must be a full snapshot:
ops against an empty previous state. A yield step with `"full": true`
additionally asserts that property: the patch must reconstruct `state` when
applied to nothing.
