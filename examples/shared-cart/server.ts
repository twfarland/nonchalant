// The server half of the pitch demo: node server.ts
// Hosts the same cart definition the tab runs locally.

import { define } from '@nonchalant/core'
import { serve } from '@nonchalant/host'
import { cart } from './shared.ts'

const host = await serve({ cart: define(cart, { evict: 60_000 }) }, { port: 4321 })
console.log(`nonchalant host on ${host.url} — schema at http://127.0.0.1:${host.port}/schema`)
