// Named tag constructors: `div({ class: 'x' }, ...children)`. Reserved-word
// collisions get a trailing underscore (`var_`); anything not listed here —
// SVG, MathML, custom elements — goes through `h()`.

import { tagFn, type TagFn } from './h.ts'

// document structure
export const html: TagFn = tagFn('html')
export const head: TagFn = tagFn('head')
export const body: TagFn = tagFn('body')
export const title: TagFn = tagFn('title')

// sectioning & landmarks
export const header: TagFn = tagFn('header')
export const footer: TagFn = tagFn('footer')
export const main: TagFn = tagFn('main')
export const nav: TagFn = tagFn('nav')
export const section: TagFn = tagFn('section')
export const article: TagFn = tagFn('article')
export const aside: TagFn = tagFn('aside')
export const h1: TagFn = tagFn('h1')
export const h2: TagFn = tagFn('h2')
export const h3: TagFn = tagFn('h3')
export const h4: TagFn = tagFn('h4')
export const h5: TagFn = tagFn('h5')
export const h6: TagFn = tagFn('h6')

// grouping
export const div: TagFn = tagFn('div')
export const p: TagFn = tagFn('p')
export const ul: TagFn = tagFn('ul')
export const ol: TagFn = tagFn('ol')
export const li: TagFn = tagFn('li')
export const dl: TagFn = tagFn('dl')
export const dt: TagFn = tagFn('dt')
export const dd: TagFn = tagFn('dd')
export const pre: TagFn = tagFn('pre')
export const blockquote: TagFn = tagFn('blockquote')
export const figure: TagFn = tagFn('figure')
export const figcaption: TagFn = tagFn('figcaption')
export const hr: TagFn = tagFn('hr')

// text-level
export const span: TagFn = tagFn('span')
export const a: TagFn = tagFn('a')
export const em: TagFn = tagFn('em')
export const strong: TagFn = tagFn('strong')
export const small: TagFn = tagFn('small')
export const code: TagFn = tagFn('code')
export const kbd: TagFn = tagFn('kbd')
export const samp: TagFn = tagFn('samp')
export const sub: TagFn = tagFn('sub')
export const sup: TagFn = tagFn('sup')
export const i: TagFn = tagFn('i')
export const b: TagFn = tagFn('b')
export const u: TagFn = tagFn('u')
export const mark: TagFn = tagFn('mark')
export const time: TagFn = tagFn('time')
export const br: TagFn = tagFn('br')
export const wbr: TagFn = tagFn('wbr')
/** `var` is a reserved word — trailing-underscore escape. */
export const var_: TagFn = tagFn('var')

// embedded
export const img: TagFn = tagFn('img')
export const picture: TagFn = tagFn('picture')
export const video: TagFn = tagFn('video')
export const audio: TagFn = tagFn('audio')
export const source: TagFn = tagFn('source')
export const track: TagFn = tagFn('track')
export const canvas: TagFn = tagFn('canvas')
export const iframe: TagFn = tagFn('iframe')
export const embed: TagFn = tagFn('embed')
export const object: TagFn = tagFn('object')

// tables
export const table: TagFn = tagFn('table')
export const caption: TagFn = tagFn('caption')
export const colgroup: TagFn = tagFn('colgroup')
export const col: TagFn = tagFn('col')
export const thead: TagFn = tagFn('thead')
export const tbody: TagFn = tagFn('tbody')
export const tfoot: TagFn = tagFn('tfoot')
export const tr: TagFn = tagFn('tr')
export const td: TagFn = tagFn('td')
export const th: TagFn = tagFn('th')

// forms
export const form: TagFn = tagFn('form')
export const fieldset: TagFn = tagFn('fieldset')
export const legend: TagFn = tagFn('legend')
export const label: TagFn = tagFn('label')
export const input: TagFn = tagFn('input')
export const button: TagFn = tagFn('button')
export const select: TagFn = tagFn('select')
export const optgroup: TagFn = tagFn('optgroup')
export const option: TagFn = tagFn('option')
export const textarea: TagFn = tagFn('textarea')
export const output: TagFn = tagFn('output')
export const progress: TagFn = tagFn('progress')
export const meter: TagFn = tagFn('meter')
export const datalist: TagFn = tagFn('datalist')

// interactive
export const details: TagFn = tagFn('details')
export const summary: TagFn = tagFn('summary')
export const dialog: TagFn = tagFn('dialog')
export const menu: TagFn = tagFn('menu')

// scripting-adjacent
export const template: TagFn = tagFn('template')
export const slot: TagFn = tagFn('slot')
export const noscript: TagFn = tagFn('noscript')
