import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // the M3 leak suite asserts "nothing retained after dispose" via
    // FinalizationRegistry/WeakRef and needs an explicit gc() handle
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
  },
})
