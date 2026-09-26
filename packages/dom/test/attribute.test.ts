// Attribute values as pure functions: the text a value renders as, and the
// javascript: URL check read the way a browser reads a scheme.

import { describe, it, expect } from 'vitest'
import { attrText, isJavascriptUrl } from '../src/attribute.ts'

describe('isJavascriptUrl', () => {
  const blocked: [string, unknown][] = [
    ['plain', 'javascript:alert(1)'],
    ['mixed case', 'JavaScript:alert(1)'],
    ['upper case', 'JAVASCRIPT:alert(1)'],
    ['leading space', '  javascript:alert(1)'],
    ['leading NUL', '\0javascript:alert(1)'],
    ['leading control character', '\x01javascript:alert(1)'],
    ['tab inside the scheme', 'java\tscript:alert(1)'],
    ['newline inside the scheme', 'java\nscript:alert(1)'],
    ['carriage return inside the scheme', 'jav\ra\r\nscript:alert(1)'],
    ['space before the colon', 'javascript :alert(1)'],
    ['a value that stringifies to one', { toString: () => 'javascript:alert(1)' }],
  ]
  for (const [what, v] of blocked) {
    it(`blocks ${what}`, () => {
      expect(isJavascriptUrl(v)).toBe(true)
    })
  }

  const allowed: [string, unknown][] = [
    ['an https URL', 'https://example.com/'],
    ['a relative path containing the word', '/javascript:ok'],
    ['a query containing the scheme', 'https://example.com/?next=javascript:x'],
    ['the word without a colon', 'javascript'],
    ['an empty string', ''],
    ['a leading DEL, which browsers do not strip', '\x7fjavascript:alert(1)'],
    ['a leading no-break space, which browsers do not strip', ' javascript:alert(1)'],
    ['an entity-encoded scheme, since nothing is decoded', '&#106;avascript:alert(1)'],
    ['null', null],
    ['a number', 42],
  ]
  for (const [what, v] of allowed) {
    it(`allows ${what}`, () => {
      expect(isJavascriptUrl(v)).toBe(false)
    })
  }
})

describe('attrText', () => {
  const cases: [name: string, value: unknown, text: string | null][] = [
    ['id', 'x', 'x'],
    ['id', '', ''],
    ['id', 3, '3'],
    ['id', 0, '0'],
    ['hidden', true, ''],
    ['hidden', false, null],
    ['id', null, null],
    ['id', undefined, null],
    ['aria-pressed', true, 'true'],
    ['aria-pressed', false, 'false'],
    ['aria-label', 'Close', 'Close'],
    ['aria-label', null, null],
    ['data-x', {}, '[object Object]'],
  ]
  for (const [name, value, text] of cases) {
    it(`renders ${name}=${String(value)} as ${JSON.stringify(text)}`, () => {
      expect(attrText(name, value)).toBe(text)
    })
  }
})
