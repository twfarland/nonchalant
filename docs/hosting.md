# Hosting safely

`@nonchalant/host` is open by default so local examples and trusted networks
need no setup. Do not treat that default as a deployment policy. A public host
should normally set both an origin policy and an authorization function:

```ts nocheck
import { serve } from '@nonchalant/host'

const host = await serve(definitions, {
  port: 4321,
  allowedOrigins: ['https://app.example'],
  authorize: async (request) => Boolean(await sessionFromRequest(request)),
})
```

`allowedOrigins` checks the WebSocket handshake's `Origin` header. An array is
appropriate for browser-only applications and rejects clients that omit the
header. A callback receives `undefined` for clients without an origin, which
lets you make an explicit decision for command-line, server, or native clients:

```ts nocheck
allowedOrigins: (origin, request) =>
  origin === 'https://app.example' ||
  (origin === undefined && isTrustedService(request))
```

An origin is not an identity. Origin policy helps stop another website from
opening a socket with a visitor's ambient credentials. `authorize` should
validate the session, bearer token, client certificate information supplied by
your proxy, or another real credential. It also protects `GET /schema`.

Connection authorization is only the first layer. `authorize` accepts or
rejects a connection, but it does not pass an identity to individual processes.
The schema only limits available lookup names, so an authenticated client could
still submit arguments that refer to another user's data. Use `scope` to create
a gateway for each accepted connection. The server then controls which
processes the session can reach:

```ts nocheck
const host = await serve(definitions, {
  port: 4321,
  allowedOrigins: ['https://app.example'],
  authorize: async (request) => Boolean(await sessionFromRequest(request)),
  scope: async (request, reg) => {
    const session = await sessionFromRequest(request)
    if (session === null) throw new Error('unauthorized') // rejects the upgrade
    return {
      lookup: (name: string) => {
        if (name !== 'cart') throw new Error(`not exposed: ${name}`)
        // the server supplies the arguments, so a client cannot name another
        // user's cart, whatever it sends
        return reg.lookup('cart', { userId: session.userId })
      },
      principal: session.userId,
    }
  },
})
```

The gateway provides one place to enforce tenancy, quotas, and auditing. It can
count lookups, record which resources a session accessed, or delegate policy
decisions to a process. Nonchalant does not define users, roles, or tokens.
Without `scope`, all accepted connections share the host registry, so exposed
processes must validate tenant, record, and operation access themselves.

## Screening messages

A process's message type is a TypeScript type, and nothing checks it at run
time. A reducer that trusts it (`msg.text.trim()`) throws on a hostile
`{ type: 'post', text: 5 }`, and a thrown reducer is a crashed process: every
client watching it goes stale and its state is lost. The host therefore
delivers only messages that are objects with a string `type`, and the
gateway's `admit` screens the rest before delivery:

<!-- ts-prelude
import { define } from '@nonchalant/core'
import type { Cast, Proc } from '@nonchalant/core'
import { serve } from '@nonchalant/host'
import type { IncomingMessage } from 'node:http'
declare const room: Proc<{ lines: string[] }, Cast<{ type: 'post'; from: string; text: string }>, { name: string }>
const definitions = { room: define(room) }
declare function sessionFromRequest(r: IncomingMessage): Promise<{ userId: string; team: string; displayName: string } | null>
-->
```ts
import type { Json } from '@nonchalant/core'

type Wire = { type: string } & { [key: string]: Json }

// rebuilt rather than passed through, so unknown fields never reach the room
const admitPost = (msg: Wire, from: string): Json | undefined =>
  msg.type === 'post' && typeof msg['text'] === 'string'
    ? { type: 'post', from, text: msg['text'] }
    : undefined

const host = await serve(definitions, {
  scope: async (request, reg) => {
    const session = await sessionFromRequest(request)
    if (session === null) throw new Error('unauthorized')
    return {
      lookup: (name: string) => {
        if (name !== 'room') throw new Error(`not exposed: ${name}`)
        return reg.lookup('room', { name: session.team })
      },
      admit: (_name, msg) => admitPost(msg, session.displayName),
      principal: session.userId,
    }
  },
})
```

`admit(name, msg)` receives the schema name the ref was looked up under and
returns the message to deliver, a replacement for it, or `undefined` to refuse.
A refused call rejects on the client with a `WireError`; a refused cast is
dropped. Returning a replacement is how a server stamps facts the client must
not choose, such as the sender of a chat line, so they come from the session
rather than from the message. A throwing `admit` counts as a refusal.

## Durable call ids

A durable process records each call's answer under the `callId` the caller
supplied, so a retry with the same id receives the recorded answer (see
[Processes on the server](server.md)). Over the wire the caller is a client, and
a client can pick any id. If ids were used as sent, a client that guessed
another user's `order-7` would read that user's result.

The host prevents this at the boundary. Before delivery, a string `callId` at
the top level of a call's message is rewritten into the connection's
principal namespace: `order-7` becomes `["alice","order-7"]`. The principal is
the gateway's `principal` when `scope` returns one. Otherwise the host
generates a random principal for each connection, so no two connections ever
share an answer record. That default is safe but forgets across reconnects:
a client whose call was cut off by a disconnect retries on a new connection,
under a new principal, and the durable callee does the work again. Set
`principal` to the user's stable id whenever retries must land on the same
record, which for durable calls is almost always. The rewritten id is what the process sees, and what it replies
under.

## Connection limits

The host applies these per connection, or per client where noted:

- `maxWatchesPerConnection` caps the number of refs a connection may watch;
  lookups beyond the cap return an error. Omit it for no cap.
- `lookupRate` caps how fast one client may look processes up. Each
  distinct lookup may spawn a process, so without a rate a client could fill
  the registry by looking up `cart` with a thousand different arguments.
  The rate is a token bucket: `max` tokens refill evenly over each `perMs`,
  and up to `burst` of them can be held at once. The default is 100 per 10
  seconds with a burst of 500. The burst exists for page loads: a page that
  looks up a few hundred remote refs when it opens gets them all at once,
  and after that the client is held to 10 lookups a second. Lookups with
  no token left return an error. A scoped gateway that derives arguments from
  the session removes the problem for its names entirely.

  The bucket belongs to the client, not the connection, so reconnecting does
  not refill it: otherwise one client could drain `totalLookupRate` (below)
  for everyone by reconnecting after every burst. A client is the `principal`
  its `scope` returns, or else the connection's remote address, and all of a
  client's connections (two tabs, say) draw on the one bucket. The host keeps
  these buckets across connections in a table capped at 10 000 clients; a
  bucket leaves the table once it has refilled, which loses nothing, since a
  new bucket starts full. Behind a reverse proxy every connection shares the
  proxy's address, so there `scope` should return a principal (the user's
  id, or the forwarded client address) or the whole site shares one bucket.
- `maxBufferedBytes` (default 8 MiB) bounds what the host queues for a client
  that is not reading. Past it the host terminates the socket rather than
  growing its memory. Nothing is lost by terminating: the client reconnects,
  re-looks-up, and receives full snapshots.
- `heartbeatMs` (default 30 seconds; `0` disables) pings each socket and
  terminates it after a missed pong. This releases watches from half-open
  connections instead of waiting for the operating system to detect them.

The host also applies these across all connections, because a per-connection
limit multiplies with the number of connections:

- `totalLookupRate` is the same kind of bucket, shared by every connection.
  The default is 1000 per second with a burst of 10 000, which admits a
  reconnect storm of a few thousand clients re-looking up a handful of refs
  each. Lookups past it return `host lookup rate exceeded`. It counts every
  lookup, including re-lookups of processes that already exist, so size it
  for your reconnect peak.
- `maxEntries` caps the host registry (default 10 000). Past it the least
  recently looked-up entries that nobody is watching are disposed, and a
  later lookup spawns them afresh. Watched entries are never evicted, so
  live processes can exceed the cap by the number that clients hold open;
  set `maxWatchesPerConnection` to bound that too. An entry holding unanswered
  calls is also kept; one merely busy with a cast, or asleep, is not. A plain
  process evicted that way loses its state. A process whose state must
  outlive eviction should be durable, so the respawn resumes from its journal,
  and a sleeping one comes back when a `scheduler` wakes it (see
  [Processes on the server](server.md)). Pass `Infinity` for no cap.

`packages/host/test/host.test.ts` checks the burst default, that reconnecting
does not refill a client's bucket, that principals sharing an address keep
separate buckets, the shared bucket across several connections, and the
registry cap; `packages/host/test/units.test.ts` checks the bucket arithmetic
and the client table on their own.

For an internet-facing service, also terminate TLS (`wss://`), set request and
connection limits at the reverse proxy, keep `maxPayloadBytes` appropriate for
the application, and log rejected handshakes without logging credentials. The
host defaults incoming payloads to 1 MiB and closes an oversized connection
with WebSocket code 1009.

`examples/shared-cart/server.ts` and `examples/chat/server.ts` put all of this
together: an origin policy, a token or handshake-derived identity, a scope that
supplies arguments, an `admit` that validates every message, and a principal.
