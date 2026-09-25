// The reference adapter against the contract every adapter certifies with.

import { describe, it, expect } from 'vitest'
import { memoryStore } from '../src/index.ts'
import { storeConformance } from '../src/conformance.ts'

storeConformance((now) => memoryStore(now), { describe, it, expect })
