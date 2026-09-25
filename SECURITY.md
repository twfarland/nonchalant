# Security

## Reporting a vulnerability

Please report security issues privately, through GitHub's
[private vulnerability reporting](https://github.com/twfarland/nonchalant/security/advisories/new)
for this repository, rather than in a public issue. Include what an attacker
controls, what they gain, and a minimal reproduction if you have one. You
should get an acknowledgement within a week.

Nonchalant is experimental alpha software with no published releases, so fixes
land on `master`; there are no supported release lines to backport to.

## Threat model, in brief

The browser packages (`core`, `dom`) run with the page's own authority. The
parts that face untrusted input are the DOM renderer, which renders
application data, and the wire host, which accepts messages from clients.
[Hosting safely](docs/hosting.md) is the full guide; this is the summary.

**Rendering.** The DOM renderer never parses strings as HTML: text becomes
text nodes and attribute values go through `setAttribute`. Markup in
application data stays inert. It does not make every attribute safe: treat
URLs from users as untrusted input and check the renderer's current attribute
policy in the [API reference](docs/api.md#nonchalantdom).

**Hosting.** `@nonchalant/host` is open by default, for local examples. A
deployed host is responsible for:

- **Who may connect.** `authorize` authenticates the schema request and the
  WebSocket upgrade with a real credential. `allowedOrigins` checks the
  handshake's `Origin` so another site cannot open a socket with a visitor's
  cookies; an origin is not an identity.
- **What each connection may reach.** The registry schema is a whitelist of
  names, not of arguments. `scope` builds a per-connection gateway so the
  server, not the client, decides which process instance a lookup reaches.
- **What each message may do.** Client messages are JSON of the client's
  choosing. Validate them at the gateway, or inside the process, before
  acting on them; a process that trusts the shape of its input trusts the
  client.
- **Whose call is whose.** Call ids arrive from clients. Anything keyed by a
  call id (a durable process's idempotency record, for instance) must be
  namespaced by the authenticated principal, or one client can collide with,
  or replay, another's.
- **How much a connection may cost.** Cap payload size, watched refs, lookup
  rate, and buffered output per connection, keep heartbeats on so half-open
  sockets release their processes, and put request limits at the reverse
  proxy. Terminate TLS (`wss://`).

The option names for each of these are in [Hosting safely](docs/hosting.md)
and the [API reference](docs/api.md#nonchalanthost).

**Durable storage.** A `Store` adapter holds process state and message logs
verbatim. Protect it as you would the application database, and give stored
call results a retention window.

**Out of scope.** Processes share one JavaScript realm: there is no isolation
between processes in a thread, and a process that blocks the event loop
blocks its neighbours. Workers are the isolation boundary.
