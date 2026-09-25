// Type-checks the TypeScript samples in README.md and docs/**/*.md.
//
// Every ```ts block is written out as its own module and compiled under the
// repository's strict settings, so a sample that drifts from the API fails
// `pnpm check`. Errors are reported against the Markdown file and line.
//
// A sample that leans on names from earlier in the page can declare them in
// an HTML comment directly above the fence, which renders as nothing:
//
//   <!-- ts-prelude
//   import type { Process } from '@nonchalant/core'
//   declare const cart: Process<number>
//   -->
//
// A block that is deliberately a fragment opts out with a `nocheck` info
// string (```ts nocheck) or a first line of `// @nocheck`.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'node_modules', '.cache', 'doc-samples')
const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')

const markdown = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(dir, f))

interface Sample { md: string; line: number; file: string; prelude: number; preludeLine: number }

const preludeAbove = (lines: string[], fence: number): { code: string[]; line: number } => {
  if (lines[fence - 1]?.trim() !== '-->') return { code: [], line: fence }
  let open = fence - 2
  while (open >= 0 && !lines[open]!.startsWith('<!-- ts-prelude')) open--
  if (open < 0) return { code: [], line: fence }
  return { code: lines.slice(open + 1, fence - 1), line: open + 1 }
}

const samples: Sample[] = []
let skipped = 0

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

for (const md of [join(root, 'README.md'), ...markdown(join(root, 'docs'))]) {
  const lines = readFileSync(md, 'utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const open = /^```ts(?:\s+(.*))?$/.exec(lines[i]!)
    if (open === null) continue
    const start = i + 1
    let end = start
    while (end < lines.length && lines[end] !== '```') end++
    const body = lines.slice(start, end)
    i = end
    if ((open[1] ?? '').split(/\s+/).includes('nocheck') || body[0]?.trim() === '// @nocheck') {
      skipped++
      continue
    }
    const prelude = preludeAbove(lines, start - 1)
    const name = `${relative(root, md).replace(/[\\/.]/g, '_')}_${start + 1}.ts`
    // the trailing export makes an import-free sample a module, so samples
    // never collide in the global scope
    writeFileSync(join(out, name), `${[...prelude.code, ...body].join('\n')}\nexport {}\n`)
    samples.push({ md, line: start + 1, file: name, prelude: prelude.code.length, preludeLine: prelude.line + 1 })
  }
}

writeFileSync(join(out, 'tsconfig.json'), JSON.stringify({
  extends: relative(out, join(root, 'tsconfig.json')).replace(/\\/g, '/'),
  compilerOptions: { types: ['node'] },
  include: ['*.ts'],
}))

try {
  execFileSync(process.execPath, [tsc, '-p', join(out, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8', stdio: 'pipe' })
  console.log(`doc samples: ${samples.length} type-checked, ${skipped} marked nocheck`)
} catch (e) {
  const output = String((e as { stdout?: unknown }).stdout ?? e)
  const byFile = new Map(samples.map((s) => [s.file, s]))
  const located = output.replace(/^(?:.*[\\/])?([^\\/\s(]+\.ts)\((\d+),(\d+)\)/gm, (whole, file: string, line: string, col: string) => {
    const s = byFile.get(file)
    if (s === undefined) return whole
    const n = Number(line)
    const at = n <= s.prelude ? s.preludeLine + n - 1 : s.line + n - s.prelude - 1
    return `${relative(root, s.md)}:${at}:${col}`
  })
  console.error(located.trim())
  console.error(`\ndoc samples failed to type-check (mark a deliberate fragment \`\`\`ts nocheck)`)
  process.exit(1)
}
