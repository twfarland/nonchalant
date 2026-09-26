// RFC 6901 JSON pointers: the path syntax every op carries. `~` ⇒ `~0`,
// `/` ⇒ `~1`; the root is the empty string. Shared by the diff (encode), the
// apply (decode + array indices), and the patch matcher (decode).

export const escapeSegment = (k: string): string =>
  k.includes('~') || k.includes('/') ? k.replaceAll('~', '~0').replaceAll('/', '~1') : k

export function unescapeSegment(s: string): string {
  if (!s.includes('~')) return s
  if (/~(?![01])/.test(s)) throw new Error(`applyPatch: invalid escape in path segment ${JSON.stringify(s)}`)
  // ~1 before ~0, so '~01' decodes to the literal '~1' (RFC 6901 §4)
  return s.replaceAll('~1', '/').replaceAll('~0', '~')
}

/** Decode a pointer into its unescaped segments. */
export function parsePath(path: string): string[] {
  if (path === '') return []
  if (path[0] !== '/') throw new Error(`applyPatch: path must start with "/" (${JSON.stringify(path)})`)
  const keys = path.slice(1).split('/')
  for (let i = 0; i < keys.length; i++) keys[i] = unescapeSegment(keys[i] as string)
  return keys
}

/**
 * A segment as an index into an array of `length`. RFC 6901's grammar: no
 * sign, exponent, whitespace, or leading zero, although `Number()` accepts
 * most of those. Out of range throws: a patch never addresses past the end
 * (`-` included; the diff grows arrays only by splice).
 */
export function arrayIndex(k: string, length: number): number {
  const idx = +k
  if (!/^(0|[1-9]\d*)$/.test(k) || idx >= length) throw new Error(`applyPatch: bad array index ${JSON.stringify(k)}`)
  return idx
}
