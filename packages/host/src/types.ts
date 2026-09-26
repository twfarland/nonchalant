import type { IncomingMessage } from 'node:http'
import type { Definition, RegistryHandle } from '@nonchalant/core'
import type { Exposable } from '@nonchalant/wire'

export interface ServeOpts<S extends { [K in keyof S]: Definition<unknown, unknown, unknown> }> {
  /** TCP port; 0 (default) picks an ephemeral one. */
  port?: number
  /** WebSocket path. Default '/'. */
  path?: string
  /** Largest accepted client message in bytes; oversize closes the connection (ws code 1009). Default 1 MiB. */
  maxPayloadBytes?: number
  /** Browser origins allowed to open a WebSocket. An array rejects clients with no Origin header. */
  allowedOrigins?: readonly string[] | OriginPolicy
  /** Authenticate the schema request and WebSocket upgrade. Omit only for trusted/local use. */
  authorize?: (request: IncomingMessage) => boolean | Promise<boolean>
  /**
   * Build the Exposable this connection's lookups go through. Runs once per
   * accepted connection, after `authorize`, before any message is served —
   * closing over the request is how a session scopes, quotas, or audits
   * lookups without the host knowing what a session is. Throwing rejects the
   * upgrade (500). Default: every connection shares the registry unscoped.
   */
  scope?: (request: IncomingMessage, reg: RegistryHandle<S>) => Exposable | Promise<Exposable>
  /** Cap on concurrently watched refs per connection; a lookup past it raises to that client. Omit for no cap. */
  maxWatchesPerConnection?: number
  /**
   * Token bucket for one client's lookups: `max` per `perMs`, up to `burst`
   * (default `max`) at once. A client is the principal its `scope` names, or
   * else its remote address, and its bucket outlives any one connection, so
   * reconnecting does not refill it. A lookup with no token left raises to
   * that client. Default 100 per 10 s with a burst of 500, so a page with a
   * few hundred remote refs loads in one go.
   */
  lookupRate?: RateLimit
  /**
   * The same bucket shared by every connection, so many connections cannot
   * multiply the spawn rate. A lookup past it raises `host lookup rate
   * exceeded`. Default 1000 per second with a burst of 10 000.
   */
  totalLookupRate?: RateLimit
  /**
   * Most registry entries kept; past it the least recently looked-up
   * unwatched entries are disposed (watched ones never are). Default 10 000;
   * `Infinity` for no cap.
   */
  maxEntries?: number
  /**
   * Ping each socket at this interval (ms) and terminate it after a missed
   * pong, so half-open connections release their watches. Default 30 s; 0 disables.
   */
  heartbeatMs?: number
  /**
   * Outbound bytes a socket may have queued before the host terminates it. A
   * client that stops reading would otherwise grow the host's memory without
   * bound; terminating is safe because reconnect is a re-lookup and a full
   * snapshot. Default 8 MiB.
   */
  maxBufferedBytes?: number
}

/** `max` tokens refill evenly over each `perMs`, up to `burst` (default `max`) held at once. */
export interface RateLimit {
  max: number
  perMs: number
  burst?: number
}

export type OriginPolicy = (
  origin: string | undefined,
  request: IncomingMessage,
) => boolean | Promise<boolean>

export interface HostHandle<S extends { [K in keyof S]: Definition<unknown, unknown, unknown> }> {
  /** Host-side access to the same processes clients see. */
  registry: RegistryHandle<S>
  port: number
  url: string
  /** Live session (connection) count. */
  sessions(): number
  close(): Promise<void>
}
