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
    }
  },
})
```

The gateway provides one place to enforce tenancy, quotas, and auditing. It can
count lookups, record which resources a session accessed, or wrap returned
processes to control `send` and `ask`. It may also delegate policy decisions to
a process. Nonchalant does not define users, roles, or tokens. Without `scope`,
all accepted connections share the host registry, so exposed processes must
validate tenant, record, and operation access themselves.

Two limits apply at the connection level. `maxWatchesPerConnection` caps the
number of refs a connection may watch; lookups beyond the cap return an error.
`heartbeatMs` pings each socket at an interval and terminates it after a missed
pong. This releases watches from half-open connections instead of waiting for
the operating system to detect them.

For an internet-facing service, also terminate TLS (`wss://`), set request and
connection limits at the reverse proxy, keep `maxPayloadBytes` appropriate for
the application, and log rejected handshakes without logging credentials. The
host defaults incoming payloads to 1 MiB and closes an oversized connection
with WebSocket code 1009.
