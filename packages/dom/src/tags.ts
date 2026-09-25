// Named tag constructors: `div({ class: 'x' }, ...children)`. Reserved-word
// collisions get a trailing underscore (`var_`); anything not listed here —
// SVG, MathML, custom elements — goes through `h()`.

import { tagFn, type TagFn } from './h.ts'

// document structure
export const html: TagFn<'html'> = tagFn('html')
export const head: TagFn<'head'> = tagFn('head')
export const body: TagFn<'body'> = tagFn('body')
export const title: TagFn<'title'> = tagFn('title')

// sectioning & landmarks
export const header: TagFn<'header'> = tagFn('header')
export const footer: TagFn<'footer'> = tagFn('footer')
export const main: TagFn<'main'> = tagFn('main')
export const nav: TagFn<'nav'> = tagFn('nav')
export const section: TagFn<'section'> = tagFn('section')
export const article: TagFn<'article'> = tagFn('article')
export const aside: TagFn<'aside'> = tagFn('aside')
export const h1: TagFn<'h1'> = tagFn('h1')
export const h2: TagFn<'h2'> = tagFn('h2')
export const h3: TagFn<'h3'> = tagFn('h3')
export const h4: TagFn<'h4'> = tagFn('h4')
export const h5: TagFn<'h5'> = tagFn('h5')
export const h6: TagFn<'h6'> = tagFn('h6')

// grouping
export const div: TagFn<'div'> = tagFn('div')
export const p: TagFn<'p'> = tagFn('p')
export const ul: TagFn<'ul'> = tagFn('ul')
export const ol: TagFn<'ol'> = tagFn('ol')
export const li: TagFn<'li'> = tagFn('li')
export const dl: TagFn<'dl'> = tagFn('dl')
export const dt: TagFn<'dt'> = tagFn('dt')
export const dd: TagFn<'dd'> = tagFn('dd')
export const pre: TagFn<'pre'> = tagFn('pre')
export const blockquote: TagFn<'blockquote'> = tagFn('blockquote')
export const figure: TagFn<'figure'> = tagFn('figure')
export const figcaption: TagFn<'figcaption'> = tagFn('figcaption')
export const hr: TagFn<'hr'> = tagFn('hr')

// text-level
export const span: TagFn<'span'> = tagFn('span')
export const a: TagFn<'a'> = tagFn('a')
export const em: TagFn<'em'> = tagFn('em')
export const strong: TagFn<'strong'> = tagFn('strong')
export const small: TagFn<'small'> = tagFn('small')
export const code: TagFn<'code'> = tagFn('code')
export const kbd: TagFn<'kbd'> = tagFn('kbd')
export const samp: TagFn<'samp'> = tagFn('samp')
export const sub: TagFn<'sub'> = tagFn('sub')
export const sup: TagFn<'sup'> = tagFn('sup')
export const i: TagFn<'i'> = tagFn('i')
export const b: TagFn<'b'> = tagFn('b')
export const u: TagFn<'u'> = tagFn('u')
export const mark: TagFn<'mark'> = tagFn('mark')
export const time: TagFn<'time'> = tagFn('time')
export const br: TagFn<'br'> = tagFn('br')
export const wbr: TagFn<'wbr'> = tagFn('wbr')
/** `var` is a reserved word — trailing-underscore escape. */
export const var_: TagFn<'var'> = tagFn('var')

// embedded
export const img: TagFn<'img'> = tagFn('img')
export const picture: TagFn<'picture'> = tagFn('picture')
export const video: TagFn<'video'> = tagFn('video')
export const audio: TagFn<'audio'> = tagFn('audio')
export const source: TagFn<'source'> = tagFn('source')
export const track: TagFn<'track'> = tagFn('track')
export const canvas: TagFn<'canvas'> = tagFn('canvas')
export const iframe: TagFn<'iframe'> = tagFn('iframe')
export const embed: TagFn<'embed'> = tagFn('embed')
export const object: TagFn<'object'> = tagFn('object')

// tables
export const table: TagFn<'table'> = tagFn('table')
export const caption: TagFn<'caption'> = tagFn('caption')
export const colgroup: TagFn<'colgroup'> = tagFn('colgroup')
export const col: TagFn<'col'> = tagFn('col')
export const thead: TagFn<'thead'> = tagFn('thead')
export const tbody: TagFn<'tbody'> = tagFn('tbody')
export const tfoot: TagFn<'tfoot'> = tagFn('tfoot')
export const tr: TagFn<'tr'> = tagFn('tr')
export const td: TagFn<'td'> = tagFn('td')
export const th: TagFn<'th'> = tagFn('th')

// forms
export const form: TagFn<'form'> = tagFn('form')
export const fieldset: TagFn<'fieldset'> = tagFn('fieldset')
export const legend: TagFn<'legend'> = tagFn('legend')
export const label: TagFn<'label'> = tagFn('label')
export const input: TagFn<'input'> = tagFn('input')
export const button: TagFn<'button'> = tagFn('button')
export const select: TagFn<'select'> = tagFn('select')
export const optgroup: TagFn<'optgroup'> = tagFn('optgroup')
export const option: TagFn<'option'> = tagFn('option')
export const textarea: TagFn<'textarea'> = tagFn('textarea')
export const output: TagFn<'output'> = tagFn('output')
export const progress: TagFn<'progress'> = tagFn('progress')
export const meter: TagFn<'meter'> = tagFn('meter')
export const datalist: TagFn<'datalist'> = tagFn('datalist')

// interactive
export const details: TagFn<'details'> = tagFn('details')
export const summary: TagFn<'summary'> = tagFn('summary')
export const dialog: TagFn<'dialog'> = tagFn('dialog')
export const menu: TagFn<'menu'> = tagFn('menu')

// scripting-adjacent
export const template: TagFn<'template'> = tagFn('template')
export const slot: TagFn<'slot'> = tagFn('slot')
export const noscript: TagFn<'noscript'> = tagFn('noscript')
