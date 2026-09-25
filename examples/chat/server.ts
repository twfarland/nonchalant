// The chat server: `pnpm chat-server`. Rooms spawn on first lookup and idle
// out an hour after the last tab leaves.
//
// Guest chat has no accounts, so there is nothing for `authorize` to check;
// the rest of docs/hosting.md still applies:
//
// - allowedOrigins: only pages this demo serves may open a socket
// - scope: a connection's identity is fixed at the handshake (?name=, or a
//   server-chosen guest name), and room args are checked before any spawn
// - admit: every post is rebuilt with that identity as `from`, so a client
//   can neither speak as someone else nor crash a room with a malformed line
//
// A real app resolves identity from its session instead, and adds `authorize`.

import type { IncomingMessage } from 'node:http'
import { define } from '@nonchalant/core'
import type { Json } from '@nonchalant/core'
import { serve } from '@nonchalant/host'
import { room } from './shared.ts'

// ---------- identity and screening ----------

// the dev server's pages; a deployment lists its real origins instead
const loopback = (origin: string | undefined): boolean =>
  origin !== undefined && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)

const nickname = (request: IncomingMessage): string => {
  const asked = new URL(request.url ?? '/', 'http://localhost').searchParams.get('name') ?? ''
  return /^[\w-]{1,24}$/.test(asked) ? asked : `guest-${Math.floor(Math.random() * 10_000)}`
}

const roomArgs = (args: unknown): { name: string } => {
  const name = (args as { name?: unknown } | undefined)?.name
  if (typeof name !== 'string' || name.trim() === '' || name.length > 40) throw new Error('bad room name')
  return { name }
}

type Wire = { type: string } & { [key: string]: Json }

const admitPost = (msg: Wire, from: string): Json | undefined =>
  msg.type === 'post' && typeof msg['text'] === 'string' ? { type: 'post', from, text: msg['text'] } : undefined

// ---------- the host ----------

const host = await serve({ room: define(room, { evict: 3_600_000 }) }, {
  port: 4322,
  allowedOrigins: loopback,
  scope: (request, reg) => {
    const from = nickname(request)
    return {
      lookup: (name: string, args: unknown) => {
        if (name !== 'room') throw new Error(`not exposed: ${name}`)
        return reg.lookup('room', roomArgs(args))
      },
      admit: (_name, msg) => admitPost(msg, from),
    }
  },
  maxWatchesPerConnection: 64,
})
console.log(`chat host on ${host.url} — open /examples/chat/ in a few tabs`)
