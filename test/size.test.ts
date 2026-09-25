// Size budgets, CI-asserted. Each bundle is what an application
// actually pays: entry + everything it pulls in, minified, gzipped. Budgets
// sit just above measured size — tighten them, never loosen them
// silently (a regression should hurt).

import { describe, it, expect } from 'vitest'
import { buildSync } from 'esbuild'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const gzipSize = (entryPoints: string[], external: string[] = []): number => {
  const result = buildSync({
    entryPoints: entryPoints.map((p) => resolve(root, p)),
    bundle: true,
    minify: true,
    format: 'esm',
    conditions: ['source'],
    external,
    write: false,
    absWorkingDir: root,
    outdir: 'out',
  })
  const total = Buffer.concat(result.outputFiles.map((f) => Buffer.from(f.contents)))
  return gzipSync(total).length
}

// measured 2026-09-26: core 8047, core+dom+tags 13192, wire 9403, durable 2297
// (with the scheduler), durable/conformance 2556, inspect 14377, react (its hooks
// plus the core they reach, react external) (bytes, gzip). Core's instrument()
// hook costs ~220 of those bytes. Durable bundles small because it imports only
// types from core. The conformance subpath is a published entry point, so it
// carries its own line.
const BUDGETS: [name: string, entries: string[], limit: number, external?: string[]][] = [
  ['@nonchalant/core', ['packages/core/src/index.ts'], 8_100],
  ['core + dom + tags (a full app)', ['packages/core/src/index.ts', 'packages/dom/src/index.ts', 'packages/dom/src/tags.ts'], 13_200],
  ['@nonchalant/wire (incl. core)', ['packages/wire/src/index.ts'], 9_500],
  ['@nonchalant/durable (incl. core)', ['packages/durable/src/index.ts'], 2_400],
  ['@nonchalant/durable/conformance', ['packages/durable/src/conformance.ts'], 2_700],
  ['@nonchalant/inspect (incl. core + dom)', ['packages/inspect/src/index.ts'], 15_000],
  // react itself is the application's, not ours
  ['@nonchalant/react (incl. core, excl. react)', ['packages/react/src/index.ts'], 7_000, ['react']],
]

describe('bundle size budgets (min+gzip)', () => {
  for (const [name, entries, limit, external] of BUDGETS) {
    it(`${name} ≤ ${limit} bytes`, () => {
      const size = gzipSize(entries, external)
      console.log(`${name}: ${size} bytes gzipped (budget ${limit})`)
      expect(size).toBeLessThanOrEqual(limit)
    })
  }
})
