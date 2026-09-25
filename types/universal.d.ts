// The globals every host shares — browsers, workers, Node, Deno, Bun, edge
// runtimes (the WinterTC minimum common API). core, wire, and durable are
// type-checked against this file instead of lib.dom or @types/node, so a
// reach for `document`, `window`, `Buffer`, or `process` fails `pnpm check`.
// Only what a universal package may use goes here; each shape is a structural
// subset of lib.dom's, so the published .d.ts files stay compatible with both.

interface Console {
  debug(...data: unknown[]): void
  error(...data: unknown[]): void
  info(...data: unknown[]): void
  log(...data: unknown[]): void
  warn(...data: unknown[]): void
}
declare var console: Console

// a number in browsers, an object in Node: opaque to universal code
declare function setTimeout(handler: () => void, timeout?: number): unknown
declare function clearTimeout(id: unknown): void
declare function queueMicrotask(callback: () => void): void

interface AbortSignal {
  readonly aborted: boolean
  readonly reason: unknown
  throwIfAborted(): void
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}
declare var AbortSignal: {
  prototype: AbortSignal
  abort(reason?: unknown): AbortSignal
  timeout(milliseconds: number): AbortSignal
  any(signals: Iterable<AbortSignal>): AbortSignal
}

interface AbortController {
  readonly signal: AbortSignal
  abort(reason?: unknown): void
}
declare var AbortController: {
  prototype: AbortController
  new (): AbortController
}

declare var crypto: { randomUUID?(): string } | undefined
