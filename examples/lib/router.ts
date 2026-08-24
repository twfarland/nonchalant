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

/**
 * The same interface over the History API — real paths, no `#`. The back
 * button works exactly as in any SPA router: pushState/replaceState navigate,
 * popstate updates the route. The cost isn't history, it's hosting: every
 * path must serve the app's HTML ("history fallback"), which is why the demo
 * gallery — a plain multi-page directory — uses hashRouter instead.
 */
export function historyRouter<R>(parse: (path: string) => R): Router<R> {
  const read = (): R => parse(location.pathname)

  const route = spawn<R, R, void>(async function* (self: Self<R>) {
    const onPop = (): void => self.cast(read())
    addEventListener('popstate', onPop)
    self.signal.addEventListener('abort', () => removeEventListener('popstate', onPop))
    yield read()
    for await (const r of self.latest()) yield r
  }, undefined, { initial: read() })

  const navigate = (path: string, opts?: NavigateOpts): void => {
    if (opts?.replace ?? true) history.replaceState(null, '', path)
    else history.pushState(null, '', path)
    // pushState/replaceState don't fire popstate — nudge the route ourselves
    ;(route as unknown as { cast(r: R): void }).cast(read())
  }

  return {
    route: route as Process<R>,
    navigate,
    link: (path, opts) => ({
      href: path,
      onclick: (e) => {
        e.preventDefault()
        navigate(path, opts)
      },
    }),
    dispose: () => route[Symbol.dispose](),
  }
}

export function hashRouter<R>(parse: (path: string) => R): Router<R> {
  const read = (): R => parse(location.hash.replace(/^#/, '') || '/')

  const route = spawn<R, R, void>(async function* (self: Self<R>) {
    const onChange = (): void => self.cast(read())
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
