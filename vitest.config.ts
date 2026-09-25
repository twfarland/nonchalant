import { defaultClientConditions, defaultServerConditions } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // test the source: the `source` export condition points @nonchalant/* at src/*.ts
  resolve: { conditions: ['source', ...defaultClientConditions] },
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
  test: {
    // the M3 leak suite asserts "nothing retained after dispose" via
    // FinalizationRegistry/WeakRef and needs an explicit gc() handle
    // node:sqlite (examples/durable-sqlite) sits behind a flag on Node 22.5–22.12;
    // later Nodes import it unflagged, and one that no longer knows the flag is
    // not handed it
    poolOptions: { forks: { execArgv: ['--expose-gc', ...(process.allowedNodeEnvironmentFlags.has('--experimental-sqlite') ? ['--experimental-sqlite'] : [])] } },
  },
})
