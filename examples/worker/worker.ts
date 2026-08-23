// The worker side, in full. Same `expose` the Node host uses — a registry
// served over a transport; only the transport underneath is different.

import { define, registry } from '@nonchalant/core'
import { expose } from '@nonchalant/wire'
import { portTransport, workerEndpoint } from '../lib/port.ts'
import { primes } from './primes.ts'

expose(registry({ primes: define(primes) }), portTransport(workerEndpoint()))
