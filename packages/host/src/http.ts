// The HTTP face: GET /schema, 404 for everything else, and the upgrade gate
// (path, then origin, then authorization) a WebSocket must pass.

import type { IncomingMessage, RequestListener } from 'node:http'
import type { Duplex } from 'node:stream'
import { PROTOCOL } from '@nonchalant/wire'
import type { OriginPolicy } from './types.ts'

export type UpgradeStatus = 401 | 403 | 404 | 500

export const pathnameOf = (request: IncomingMessage): string =>
  new URL(request.url ?? '/', 'http://localhost').pathname

const REASONS: Record<UpgradeStatus, string> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  500: 'Internal Server Error',
}

/** The raw response that refuses an upgrade: the socket has not become a WebSocket, so it still speaks HTTP. */
export const refusal = (status: UpgradeStatus): string =>
  `HTTP/1.1 ${status} ${REASONS[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`

export const rejectUpgrade = (socket: Duplex, status: UpgradeStatus): void => {
  if (socket.destroyed) return
  socket.write(refusal(status))
  socket.destroy()
}

/** An array policy is an exact allowlist, so a client that sends no Origin fails it. */
export const originAllowed = async (
  policy: readonly string[] | OriginPolicy | undefined,
  origin: string | undefined,
  request: IncomingMessage,
): Promise<boolean> =>
  policy === undefined
    ? true
    : typeof policy === 'function'
      ? await policy(origin, request)
      : origin !== undefined && policy.includes(origin)

/** Why an upgrade is refused, or undefined to accept it. The first failing check decides. */
export async function screenUpgrade(
  request: IncomingMessage,
  path: string,
  policy: readonly string[] | OriginPolicy | undefined,
  authorize: (request: IncomingMessage) => Promise<boolean>,
): Promise<UpgradeStatus | undefined> {
  if (pathnameOf(request) !== path) return 404
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined
  if (!await originAllowed(policy, origin, request)) return 403
  if (!await authorize(request)) return 401
  return undefined
}

/** GET /schema serves the name whitelist; anything else is a 404, and a throwing authorize a 500. */
export const schemaRoute = (
  names: readonly string[],
  authorize: (request: IncomingMessage) => Promise<boolean>,
): RequestListener => (req, res) => {
  void (async () => {
    if (req.method === 'GET' && pathnameOf(req) === '/schema') {
      if (!await authorize(req)) {
        res.statusCode = 401
        res.end()
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ protocol: PROTOCOL, names }))
      return
    }
    res.statusCode = 404
    res.end()
  })().catch(() => {
    res.statusCode = 500
    res.end()
  })
}
