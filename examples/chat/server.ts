// The chat server: node via `pnpm chat-server`. One definition, one line of
// hosting. Rooms spawn on first lookup and idle out an hour after the last
// tab leaves.

import { define } from '@nonchalant/core'
import { serve } from '@nonchalant/host'
import { room } from './shared.ts'

const host = await serve({ room: define(room, { evict: 3_600_000 }) }, { port: 4322 })
console.log(`chat host on ${host.url} — open /examples/chat/ in a few tabs`)
