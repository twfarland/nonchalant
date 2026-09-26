// Prints what each published entry point costs an application: the entry plus
// everything it pulls in, minified and gzipped. A report, not a gate — size is
// weighed against features, not capped.

import { buildSync } from 'esbuild'
import { gzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const gzipSize = (entryPoints: string[]): number => {
  const result = buildSync({
    entryPoints: entryPoints.map((p) => resolve(root, p)),
    bundle: true,
    minify: true,
    format: 'esm',
    conditions: ['source'],
    write: false,
    absWorkingDir: root,
    outdir: 'out',
  })
  return gzipSync(Buffer.concat(result.outputFiles.map((f) => Buffer.from(f.contents)))).length
}

const ENTRIES: [name: string, entries: string[]][] = [
  ['@nonchalant/core', ['packages/core/src/index.ts']],
  ['core + dom + tags (a full app)', ['packages/core/src/index.ts', 'packages/dom/src/index.ts', 'packages/dom/src/tags.ts']],
  ['@nonchalant/wire (incl. core)', ['packages/wire/src/index.ts']],
  ['@nonchalant/durable (incl. core)', ['packages/durable/src/index.ts']],
  ['@nonchalant/durable/conformance', ['packages/durable/src/conformance.ts']],
  ['@nonchalant/inspect (incl. core + dom)', ['packages/inspect/src/index.ts']],
]

const width = Math.max(...ENTRIES.map(([name]) => name.length))
for (const [name, entries] of ENTRIES) {
  const kb = (gzipSize(entries) / 1024).toFixed(1)
  console.log(`${name.padEnd(width)}  ${kb.padStart(5)} KB min+gzip`)
}
