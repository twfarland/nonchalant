// Attribute types, derived per tag from the DOM lib. Types only: nothing here
// reaches a bundle, and the sink reads every attrs object as plain `Attrs`.

interface SpecialAttrs {
  /** Identity for keyed reconciliation. `key: 0` is a valid key (presence, not truthiness). */
  readonly key?: unknown
  /** Exit-transition hook: called with the element on removal; detach waits for the result. */
  readonly exit?: (el: Element) => unknown
  /** Explicit namespace for the element (otherwise inferred: svg/math subtrees). */
  readonly ns?: string
}

/** Untyped attributes: the shape every sink reads, and the escape hatch for names the DOM lib doesn't know. */
export interface Attrs extends SpecialAttrs {
  /**
   * Everything else: static values, `on*` listeners (functions), or reactive
   * bindings (thunks / processes — any callable that is not an `on*` name).
   */
  readonly [name: string]: unknown
}

// A value, or a binding to one: the sink runs any non-`on*` function as a
// tracked read (thunks and processes alike) and null/undefined/false remove.
type Bound<T> = T | null | undefined | (() => T | null | undefined)

type Primitive = string | number | boolean

// setAttribute stringifies, so a number is as good as a string and vice versa
type Widen<P> = P extends boolean ? boolean : P extends string | number ? string | number : never

type IfEqual<X, Y, A, B> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? A : B

// IDL properties with no attribute of the lowercased name (or none at all)
type NotAttributes =
  | keyof Node
  | Exclude<keyof ARIAMixin, 'role'>
  | Exclude<keyof HTMLHyperlinkElementUtils, 'href'>
  | 'innerHTML' | 'outerHTML' | 'innerText' | 'outerText' | 'scrollTop' | 'scrollLeft'
  | 'defaultValue' | 'defaultChecked' | 'defaultSelected' | 'defaultMuted' | 'indeterminate'
  | 'valueAsNumber' | 'selectionStart' | 'selectionEnd' | 'selectionDirection'
  | 'selectedIndex' | 'length' | 'text' | 'returnValue'
  | 'currentTime' | 'volume' | 'playbackRate' | 'defaultPlaybackRate'
  | 'draggable' | 'spellcheck' | 'translate'

// named keys only: HTMLFormElement and HTMLSelectElement carry index signatures
type NamedKeys<E> = keyof { [K in keyof E as string extends K ? never : number extends K ? never : K]: 0 }

// writable, primitive-valued, attribute-backed
type AttrKeys<E> = {
  [K in NamedKeys<E>]-?: K extends NotAttributes
    ? never
    : E[K] extends Primitive | null
      ? IfEqual<{ [Q in K]: E[K] }, { -readonly [Q in K]: E[K] }, K, never>
      : never
}[NamedKeys<E>]

type AttrName<K extends string> = K extends 'className'
  ? 'class'
  : K extends 'htmlFor'
    ? 'for'
    : K extends 'httpEquiv'
      ? 'http-equiv'
      : K extends 'acceptCharset'
        ? 'accept-charset'
        : Lowercase<K>

// enumerated attributes whose IDL property is boolean: `true` would render
// the invalid empty string, so they take their spelled-out values
interface HtmlGlobalAttrs {
  readonly style?: Bound<string>
  readonly draggable?: Bound<'true' | 'false'>
  readonly spellcheck?: Bound<'true' | 'false'>
  readonly translate?: Bound<'yes' | 'no'>
  readonly [data: `data-${string}`]: Bound<Primitive>
  readonly [aria: `aria-${string}`]: Bound<Primitive>
}

// chosen by tag name: a structural `E extends HTMLMediaElement` test would
// compare whole element interfaces on every lookup
type HtmlEventMap<K> = K extends 'video'
  ? HTMLVideoElementEventMap
  : K extends 'audio'
    ? HTMLMediaElementEventMap
    : K extends 'body'
      ? HTMLBodyElementEventMap
      : HTMLElementEventMap

// the sink listens for the name after `on` verbatim, so `onClick` would wait
// for a "Click" event that never comes: only lowercase names exist here
type EventAttrs<E, M> = {
  readonly [K in keyof M & string as `on${K}`]?:
    | ((e: M[K] & { readonly currentTarget: E }) => void)
    | null
    | undefined
}

/** The attributes of an HTML element: its writable attribute-backed properties, `data-*`, `aria-*`, and lowercase `on*` listeners. */
export type HtmlAttrs<E, M = HTMLElementEventMap> = SpecialAttrs &
  HtmlGlobalAttrs &
  EventAttrs<E, M> & { readonly [K in AttrKeys<E> & string as AttrName<K>]?: Bound<Widen<E[K]>> }

// SVG attributes (`d`, `fill`, `viewBox` …) are not properties in the DOM lib,
// so only the listeners are typed and every other name stays open
/** The attributes of an SVG element: typed lowercase `on*` listeners; anything else is unchecked. */
export type SvgAttrs<E> = EventAttrs<E, SVGElementEventMap> & Attrs

/**
 * Attributes for a tag name: typed for HTML and SVG tags (HTML wins on the
 * shared names `a`, `script`, `style`, `title`), untyped `Attrs` for anything
 * else. Widening the tag to `string` — `h(tag as string, attrs)` — is the
 * escape for a name the DOM lib doesn't know.
 */
// The outer `K extends unknown` makes the type distributive, so while a call
// is still inferring K its constraint resolves at K = string (to `Attrs`)
// rather than as the union of every element's attributes (~200k type
// instantiations for a single h('div', {...})).
export type AttrsFor<K extends string> = K extends unknown
  ? string extends K
    ? Attrs
    : K extends keyof HTMLElementTagNameMap
      ? HtmlAttrs<HTMLElementTagNameMap[K], HtmlEventMap<K>>
      : K extends keyof SVGElementTagNameMap
        ? SvgAttrs<SVGElementTagNameMap[K]>
        : Attrs
  : never
