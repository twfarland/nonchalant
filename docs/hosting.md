# Hosting safely

`@nonchalant/host` is open by default so local examples and trusted networks
need no setup. Do not treat that default as a deployment policy. A public host
should normally set both an origin policy and an authorization function:

```ts
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

```ts
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

```ts
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
share an answer record. Set `principal` to the user's stable id when a user's
retries must land on the same record across reconnects, which is usually what
you want. The rewritten id is what the process sees, and what it replies
under.

## Connection limits

The host applies these per connection:

- `maxWatchesPerConnection` caps the number of refs a connection may watch;
  lookups beyond the cap return an error. Omit it for no cap.
- `lookupRate` caps lookups per window (default 100 per 10 seconds). Each
  distinct lookup may spawn a process, so without a rate a client could fill
  the registry by looking up `cart` with a thousand different arguments.
  Lookups past the rate return an error. A scoped gateway that derives
  arguments from the session removes the problem for its names entirely.
- `maxBufferedBytes` (default 8 MiB) bounds what the host queues for a client
  that is not reading. Past it the host terminates the socket rather than
  growing its memory. Nothing is lost by terminating: the client reconnects,
  re-looks-up, and receives full snapshots.
- `heartbeatMs` (default 30 seconds; `0` disables) pings each socket and
  terminates it after a missed pong. This releases watches from half-open
  connections instead of waiting for the operating system to detect them.

For an internet-facing service, also terminate TLS (`wss://`), set request and
connection limits at the reverse proxy, keep `maxPayloadBytes` appropriate for
the application, and log rejected handshakes without logging credentials. The
host defaults incoming payloads to 1 MiB and closes an oversized connection
with WebSocket code 1009.

`examples/shared-cart/server.ts` and `examples/chat/server.ts` put all of this
together: an origin policy, a token or handshake-derived identity, a scope that
supplies arguments, an `admit` that validates every message, and a principal.
