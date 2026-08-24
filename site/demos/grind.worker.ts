// The worker half of the demo next door, in full: a registry served over the
// port back to the page. The process is the gallery's, unchanged — it has no
// idea it is on another thread.

import { define, registry } from '@nonchalant/core'
import { expose, portTransport, workerEndpoint } from '@nonchalant/wire'
import { primes } from '../../examples/worker/primes.ts'

expose(registry({ primes: define(primes) }), portTransport(workerEndpoint()))
