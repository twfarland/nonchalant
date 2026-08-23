// The plain highlighter: comments, strings, keywords — nothing fancier, and
// no dependency. It emits the same three span classes the example pages use
// (`c`, `s`, `k`), so one set of CSS rules styles every code block on the site.
//
// A single left-to-right scan, so a keyword inside a string or a quote inside
// a comment can never be mistaken for markup.

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'from', 'function', 'if', 'implements', 'import',
  'in', 'instanceof', 'interface', 'keyof', 'let', 'new', 'null', 'of',
  'readonly', 'return', 'satisfies', 'static', 'switch', 'this', 'throw',
  'true', 'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'yield',
])

const escape = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const span = (cls: string, text: string): string => `<span class="${cls}">${escape(text)}</span>`

const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c)
const isIdent = (c: string): boolean => /[A-Za-z0-9_$]/.test(c)

/** Highlight TypeScript source as HTML. The input is escaped; the output is trusted markup. */
export function highlight(source: string): string {
  let out = ''
  let i = 0

  while (i < source.length) {
    const c = source[i] as string
    const next = source[i + 1]

    // line comment
    if (c === '/' && next === '/') {
      let j = i
      while (j < source.length && source[j] !== '\n') j++
      out += span('c', source.slice(i, j))
      i = j
      continue
    }

    // block comment
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const j = end === -1 ? source.length : end + 2
      out += span('c', source.slice(i, j))
      i = j
      continue
    }

    // string or template literal (no interpolation highlighting — plain, by design)
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === c) {
          j++
          break
        }
        j++
      }
      out += span('s', source.slice(i, j))
      i = j
      continue
    }

    // identifier — a keyword only if the whole word matches
    if (isIdentStart(c)) {
      let j = i
      while (j < source.length && isIdent(source[j] as string)) j++
      const word = source.slice(i, j)
      out += KEYWORDS.has(word) ? span('k', word) : escape(word)
      i = j
      continue
    }

    out += escape(c)
    i++
  }

  return out
}
