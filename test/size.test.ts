// Size budgets, CI-asserted. Each bundle is what an application
// actually pays: entry + everything it pulls in, minified, gzipped. Budgets
// carry ~25% headroom over measured size — tighten them, never loosen them
// silently (a regression should hurt).

import { describe, it, expect } from 'vitest'
import { buildSync } from 'esbuild'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const gzipSize = (entryPoints: string[]): number => {
  const result = buildSync({
    entryPoints: entryPoints.map((p) => resolve(root, p)),
    bundle: true,
    minify: true,
    format: 'esm',
    write: false,
    absWorkingDir: root,
    outdir: 'out',
  })
  const total = Buffer.concat(result.outputFiles.map((f) => Buffer.from(f.contents)))
  return gzipSync(total).length
}

// measured 2026-08-22: core 6160, core+dom+tags 10554, wire 7423 (bytes, gzip)
const BUDGETS: [name: string, entries: string[], limit: number][] = [
  ['@nonchalant/core', ['packages/core/src/index.ts'], 8_000],
  ['core + dom + tags (a full app)', ['packages/core/src/index.ts', 'packages/dom/src/index.ts', 'packages/dom/src/tags.ts'], 13_000],
  ['@nonchalant/wire (incl. core)', ['packages/wire/src/index.ts'], 9_500],
]

describe('bundle size budgets (min+gzip)', () => {
  for (const [name, entries, limit] of BUDGETS) {
    it(`${name} ≤ ${limit} bytes`, () => {
      const size = gzipSize(entries)
      console.log(`${name}: ${size} bytes gzipped (budget ${limit})`)
      expect(size).toBeLessThanOrEqual(limit)
    })
  }
})
