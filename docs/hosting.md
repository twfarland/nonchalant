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

Authorization has another layer. The host hook accepts or rejects a connection
but does not pass an identity into a process. A schema is only a whitelist of
lookup names; an authenticated client could still ask for another user's
arguments or send a message it should not be allowed to send. Design exposed
processes so they validate tenant, record, and operation access, or expose a
registry already scoped to the authenticated session.

For an internet-facing service, also terminate TLS (`wss://`), set request and
connection limits at the reverse proxy, keep `maxPayloadBytes` appropriate for
the application, and log rejected handshakes without logging credentials. The
host defaults incoming payloads to 1 MiB and closes an oversized connection
with WebSocket code 1009.
