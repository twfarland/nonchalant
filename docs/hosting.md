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

Authorization has another layer. `authorize` accepts or rejects a connection
but does not pass an identity into a process, and a schema is only a whitelist
of lookup names — an authenticated client could still ask for another user's
arguments. The `scope` option is the seam that closes this gap: it runs once
per accepted connection and returns the gateway that connection's lookups go
through, so the server — never the client — decides which processes a session
can reach:

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
        // the server supplies the arguments — a client cannot name another
        // user's cart, whatever it sends
        return reg.lookup('cart', { userId: session.userId })
      },
    }
  },
})
```

The gateway is one interception point for tenancy, quotas, and auditing: count
lookups before delegating, log what a session touched, or wrap the returned
process to gate `send` and `ask`. It can itself delegate to a process, making
the session a single writer for its own policy. The framework never learns
what a user, role, or token is. Without `scope`, every accepted connection
shares the host registry, and exposed processes must validate tenant, record,
and operation access themselves.

Two connection-level limits are built in. `maxWatchesPerConnection` caps how
many refs one connection may watch at once — past the cap a lookup answers
with an error instead of retaining another process. `heartbeatMs` pings each
socket on an interval and terminates it after a missed pong, so half-open
connections (a peer that vanished without closing) release their watches
instead of holding them until the OS notices.

For an internet-facing service, also terminate TLS (`wss://`), set request and
connection limits at the reverse proxy, keep `maxPayloadBytes` appropriate for
the application, and log rejected handshakes without logging credentials. The
host defaults incoming payloads to 1 MiB and closes an oversized connection
with WebSocket code 1009.
