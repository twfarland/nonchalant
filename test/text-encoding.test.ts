// Every text file in the repository is valid UTF-8. A stray cp1252 byte (an
// em dash pasted from a word processor) renders as U+FFFD on GitHub and on
// the doc site, and nothing else catches it.

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const text = /\.(md|ts|html|css|json|ya?ml|txt)$/
const skip = /(^|[\\/])(node_modules|dist|\.git|\.claude)([\\/]|$)/

const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
  .filter((f) => text.test(f) && !skip.test(f))

describe('text encoding', () => {
  it('every text file decodes as UTF-8', () => {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const invalid = files.filter((f) => {
      try {
        decoder.decode(readFileSync(join(root, f)))
        return false
      } catch {
        return true
      }
    })
    expect(invalid.map((f) => relative(root, join(root, f)))).toEqual([])
    expect(files.length).toBeGreaterThan(100)
  })
})
