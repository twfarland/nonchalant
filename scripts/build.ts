// Builds the package in the current directory: tsc emits dist/*.js and
// dist/*.d.ts from tsconfig.build.json. Run through `pnpm build`, which visits
// packages in dependency order — a package's build resolves its @nonchalant/*
// imports to their already-built dist/*.d.ts (the build configs drop the
// `source` condition), so nothing is compiled twice.
//
// tsc rewrites relative `.ts` specifiers to `.js` in the emitted JavaScript
// but leaves them as `.ts` in declarations, which a consumer without
// allowImportingTsExtensions cannot load. The declarations are rewritten here.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const cwd = process.cwd()
const dist = join(cwd, 'dist')
const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')

rmSync(dist, { recursive: true, force: true })
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd, stdio: 'inherit' })

const relativeTs = /((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g

for (const file of readdirSync(dist, { recursive: true, encoding: 'utf8' })) {
  if (!file.endsWith('.d.ts')) continue
  const path = join(dist, file)
  const text = readFileSync(path, 'utf8')
  const fixed = text.replace(relativeTs, '$1$2.js$3')
  if (fixed !== text) writeFileSync(path, fixed)
}
