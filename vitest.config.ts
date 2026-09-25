import { defaultClientConditions, defaultServerConditions } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // test the source: the `source` export condition points @nonchalant/* at src/*.ts
  resolve: { conditions: ['source', ...defaultClientConditions] },
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
  test: {
    // the M3 leak suite asserts "nothing retained after dispose" via
    // FinalizationRegistry/WeakRef and needs an explicit gc() handle
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
  },
})
