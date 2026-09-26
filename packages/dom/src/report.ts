// Where the sink's complaints go: render-time failures through a swappable
// handler, authoring mistakes through console.warn, once per distinct message.

export type RenderErrorHandler = (what: string, error: unknown) => void

// render-time failures (a throwing binding, a rejected slot promise) are
// contained to their region; this hook only decides where the report goes
let report: RenderErrorHandler = (what, e) => console.error(`nonchalant/dom: ${what}`, e)

/** Route render failure reports somewhere other than console.error. Returns a restore function. */
export function onRenderError(handler: RenderErrorHandler): () => void {
  const prev = report
  report = handler
  return () => {
    report = prev
  }
}

export const warn = (what: string, e?: unknown): void => report(what, e)

// authoring mistakes: each distinct message once, not once per row
const linted = new Set<string>()
export const lint = (what: string): void => {
  if (linted.has(what)) return
  linted.add(what)
  console.warn(`nonchalant/dom: ${what}`)
}
