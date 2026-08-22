// A hash router as a userland construct — no framework hooks, no privileged
// access, ~40 lines. The current route is a process; links navigate with
// `location.replace` by default so browsing around doesn't build an annoying
// back-button chain (pass { replace: false } where a history entry is wanted).

import { spawn } from '@nonchalant/core'
import type { Process, Self } from '@nonchalant/core'

export interface NavigateOpts {
  /** Replace the current history entry instead of pushing one. Default true. */
  replace?: boolean
}

export interface Router<R> {
  /** The current route: read it, bind on it, or `for await` it. */
  route: Process<R>
  navigate(path: string, opts?: NavigateOpts): void
  /** Spreadable anchor attrs: real href for the URL bar, onclick that navigates in-page. */
  link(path: string, opts?: NavigateOpts): { href: string; onclick: (e: Event) => void }
  dispose(): void
}

export function hashRouter<R>(parse: (path: string) => R): Router<R> {
  const read = (): R => parse(location.hash.replace(/^#/, '') || '/')

  const route = spawn<R, R, void>(async function* (self: Self<R>) {
    const onChange = (): void => self.send(read())
    addEventListener('hashchange', onChange)
    self.signal.addEventListener('abort', () => removeEventListener('hashchange', onChange))
    yield read()
    for await (const r of self.latest()) yield r
  }, undefined, { initial: read() })

  const navigate = (path: string, opts?: NavigateOpts): void => {
    if (opts?.replace ?? true) location.replace(`#${path}`)
    else location.hash = path
  }

  return {
    route: route as Process<R>,
    navigate,
    link: (path, opts) => ({
      href: `#${path}`,
      onclick: (e) => {
        e.preventDefault()
        navigate(path, opts)
      },
    }),
    dispose: () => route[Symbol.dispose](),
  }
}
