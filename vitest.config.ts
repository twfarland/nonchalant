import { defaultClientConditions, defaultServerConditions } from 'vite'
import { configDefaults, defineConfig } from 'vitest/config'

const PERF = '**/*.perf.test.ts'

export default defineConfig({
  // test the source: the `source` export condition points @nonchalant/* at src/*.ts
  resolve: { conditions: ['source', ...defaultClientConditions] },
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
  test: {
    // the M3 leak suite asserts "nothing retained after dispose" via
    // FinalizationRegistry/WeakRef and needs an explicit gc() handle
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
    projects: [
      { extends: true, test: { name: 'unit', exclude: [...configDefaults.exclude, PERF] } },
      // wall-clock budgets run alone, after every other file has finished, so
      // a busy neighbour worker can't spend their time
      { extends: true, test: { name: 'perf', include: [PERF], sequence: { groupOrder: 1 } } },
    ],
  },
})
