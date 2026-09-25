// Builds every package, packs each into a temporary directory exactly as
// `pnpm publish` would (publishConfig applied, workspace: ranges replaced),
// and lints the tarballs: publint for the manifest and file layout,
// are-the-types-wrong for declaration resolution. Needs the network for
// `pnpm dlx` on the first run.

import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packages = ['core', 'dom', 'wire', 'durable', 'host']

const run = (command: string, cwd = root): void => {
  console.log(`$ ${command}`)
  execSync(command, { cwd, stdio: 'inherit' })
}

run('pnpm -r run build')

const out = mkdtempSync(join(tmpdir(), 'nonchalant-pack-'))
try {
  for (const name of packages) run(`pnpm pack --pack-destination "${out}"`, join(root, 'packages', name))
  for (const tarball of readdirSync(out).filter((f) => f.endsWith('.tgz'))) {
    const path = join(out, tarball)
    run(`pnpm dlx publint@0.3 run "${path}" --strict`)
    run(`pnpm dlx @arethetypeswrong/cli@0.18 "${path}" --profile esm-only`)
  }
} finally {
  rmSync(out, { recursive: true, force: true })
}
