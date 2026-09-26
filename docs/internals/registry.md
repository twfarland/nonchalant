# registry.ts: naming, sharing, and eviction

`packages/core/src/registry.ts`, with key encoding in `key.ts`. Imports
`process.ts` and `scope.ts`. The smallest module with
the largest design claim: `lookup(name, args)` is get-or-spawn, and that one
operation provides dependency injection, process caching, and remote addressing
when a transport is involved.

The new-concept bar in `CLAUDE.md` says a public concept must dissolve at least
two existing problems. This is the one that earned its place by dissolving
three.

## Lookup

```mermaid
flowchart TD
    L["lookup(name, args)"] --> K["key = name + NUL + encodeArg(args)"]
    K --> E{"entry cached?"}
    E -->|yes| RET["return the same handle"]
    E -->|no| D{"name in schema?"}
    D -->|no| T["throw; the schema is the whitelist"]
    D -->|yes| S["spawn, unscoped"]
    S --> W["start the idle timer<br/>(only if the definition declares evict)"]
    W --> RET
```

Two properties fall out of the cache being keyed on `name + args`:

- The same key returns the same handle, so every caller shares one process. This makes
  it dependency injection without prop drilling.
- Different arguments return a different process, providing query-cache
  (`name + args` is the queryKey).

The schema lookup doubles as the security whitelist: a name that isn't in
`defs` throws, so nothing outside the schema can be spawned locally or by a
remote peer through `expose()`.

Registry spawns are wrapped in `unscoped()`. Shared state must not be owned by
whichever process happened to look it up first, or the second caller's handle
would die when the first caller did. This is the one place ambient ownership is
suspended (see [process.md](process.md)).

## Key encoding

`key.ts`. `keyEncoder()` returns the registry's `argsKey`, with its own
identity table (ids are stable for the life of one registry). Its `encodeArg` is a structural serialiser, not `JSON.stringify`. The differences
all matter:

| input | encoded as | why |
|---|---|---|
| `{ a: 1, b: 2 }` / `{ b: 2, a: 1 }` | same string (keys sorted) | argument order must not split the cache |
| `1` vs `'1'` vs `true` | type-tagged (`number:1`, `string:"1"`, `true`) | no collisions across types |
| `NaN`, `±Infinity`, `-0` | `number:NaN`, `number:Infinity`, `number:-0` | `JSON.stringify` turns these into `null`/`0`; `String()` spells all but `-0` |
| `undefined` vs missing | `undefined` | distinguishable |
| `bigint`, `symbol` | tagged; symbols get a stable id | not JSON-representable; `1n`, `1` and `'1'` stay distinct |
| array holes | `hole` | `[, 1]` and `[undefined, 1]` are different arguments |
| a cycle | `cycle:<id>` | encoding must terminate |
| class instance, `Map`, `Date`, function | identity id from a `WeakMap` | no structural identity to rely on |

The identity fallback means that two structurally identical `Date`
arguments are *different* cache keys, because the encoder cannot know whether
a non-plain type's structure defines its identity. Plain-data arguments are the
supported path. This matches the rule used by the rest of the library and explains why
the same key works over the wire.

The separator between name and encoded args is a NUL character, which no
realistic schema name contains, preventing one name/args pair from colliding with a
differently-split one.

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Live: lookup; spawn and start idle timer
    Live --> Watched: a watcher subscribes<br/>(timer cleared)
    Watched --> Watched: more watchers come and go
    Watched --> Idle: last watcher leaves<br/>(timer restarts)
    Idle --> Watched: a watcher subscribes
    Idle --> [*]: timer fires; dispose and forget
    Live --> [*]: process returns (onSettled)<br/>or evict(name, args)
```

**Watchers are subscriptions, not reads.** Effects that read the value or the
lifecycle metadata, directly or through derives and iterators, are watchers.
The graph counts each gate whose reader has an effect downstream
([graph.md](graph.md)), and that count is the refcount. A plain snapshot pull
is not watching, and neither is a derive that is read only as a snapshot, even
though it stays linked. That is SWR semantics on purpose: an evicted entry simply
respawns on the next lookup, so a caller who only pulls occasionally is not
holding a process open.

The idle timer, when there is one, **starts at lookup** rather than when the
first watcher leaves. A process that is looked up and never watched therefore still
evicts. It is cleared when the count goes above zero and restarted when it
returns to zero.

There is a timer only when the definition declares `evict`. Without it the
entry has no idle timeout at all and stays resident until the process ends or
someone calls `evict()`. This is the appropriate default for state that should
outlive its watchers, and a leak for state that shouldn't. It is also what a
remote `exit` does *not* do: releasing the last watch reclaims the process only
if its definition opted in (see [PROTOCOL.md](../PROTOCOL.md)).

`onSettled` handles the other exit: a process that returns or crashes
terminally removes its own entry, so the next lookup starts fresh rather than
handing out a finished process. Both `onSettled` and the eviction timer check
`entries.get(key) === created` before acting, so a stale callback from a
superseded entry cannot delete its replacement.

`evict(name)` drops every entry under a name; `evict(name, args)` drops one.
Both dispose immediately rather than waiting for the timer.

## Capacity

`registry(defs, { maxEntries })` caps the cache. Without a cap, a caller that
looks up distinct arguments (an id from user input, a search string) grows the
cache without bound whenever the definition has no `evict` timeout. That is a
memory DoS if the arguments come from a remote peer. With a cap, the `entries`
map doubles as the recency list: a hit deletes and re-inserts its key, so
iteration order runs from least to most recently looked up. After a spawn
takes the map past the cap, the oldest *unwatched* entries are disposed until
it fits. The policy is `evictionOrder(entries, keep)`, a lazy scan that yields
the keys it may evict (unwatched, not `busy`, not the entry just spawned) so
`lookup` stops pulling as soon as the map fits. An entry holding unanswered calls is skipped too: evicting it would reject
them under their callers. A watched entry is never evicted to make room, so a registry whose
entries are all watched can sit above the cap until watchers leave. Every
entry keeps its own watcher count from `onWatchers`, whether or not its
definition declares `evict`.

## Where this shows up elsewhere

`RegistryHandle` and the remote `Connection` implement the same `Registry`
interface, which is what "a name resolves identically at every distance" means
in practice. `connect(transport)` substitutes the transport and keeps the
interface. The remote side's cache is keyed the same way (canonicalised JSON
args, `entryKey` in `wire/entry.ts`), so client-side get-or-spawn behaves like the local
one.

`expose(reg, transport)` accepts anything with a `lookup` method, not a
`RegistryHandle` specifically. That is the seam the Node host's `scope` option
uses to give each connection its own gateway; see
[hosting.md](../hosting.md).

Tests: `packages/core/test/registry.test.ts` (key equivalence, the encoding
table above value by value, sharing, refcounting, snapshot derives not
pinning, eviction timing, respawn after eviction, the `maxEntries` cap), and
`registry.helpers.test.ts` (the exact key strings `keyEncoder` produces, and
`evictionOrder` over synthetic entry lists).

Back to the [overview](README.md).
