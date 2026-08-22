// @nonchalant/dom — tag constructors and the DOM sink (M4).
// Nodes are plain typed data ({ tag, attrs, children }); the sink builds them
// with createElement/createTextNode/setAttribute — no string is ever parsed as
// markup. Named tags live in ./tags (var_ escapes); h() covers SVG/MathML/
// custom elements. mount() attaches a VNode, thunk, or view process to an
// element; domSink() adapts a container to core's generic mount(sink, view).

export { h, tagFn } from './h.ts'
export type { Attrs, TagFn } from './h.ts'
export { mount, domSink } from './render.ts'
export type { View } from './render.ts'
