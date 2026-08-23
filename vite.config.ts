// Build config for the static site: the documentation page at the root, plus
// the example gallery under /examples/. `pnpm dev` is unaffected — this file
// only adds build inputs, so the dev server still serves the repo as before.
//
// Deployed with `vite build --base=/nonchalant/` (see .github/workflows/pages.yml).

import { cp, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))

// Every page that runs in the browser alone. `examples/chat/` is deliberately
// absent: it dials ws://127.0.0.1:4322 at module scope, and constructing an
// insecure WebSocket from an https page throws outright, which would leave the
// page blank rather than merely disconnected. It stays a run-it-locally demo.
const pages = [
  'index.html',                                  // the documentation site
  'examples/index.html',                         // the gallery
  'examples/counter/index.html',
  'examples/todomvc/index.html',
  'examples/typeahead/index.html',
  'examples/form/index.html',
  'examples/router/index.html',
  'examples/undo-redo/index.html',
  'examples/query/index.html',
  'examples/drag/index.html',
  'examples/bounce/index.html',
  'examples/multi-tab/index.html',
  'examples/shared-cart/index.html',
  'examples/mario/index.html',
  'examples/js-framework-benchmark/index.html',
  'examples/7guis/counter.html',
  'examples/7guis/temperature.html',
  'examples/7guis/flight-booker.html',
  'examples/7guis/timer.html',
  'examples/7guis/crud.html',
  'examples/7guis/circle-drawer.html',
  'examples/7guis/cells.html',
]

/** Mario builds its sprite paths at runtime, so the bundler cannot see them. */
const marioSprites = (): Plugin => ({
  name: 'nonchalant:mario-sprites',
  apply: 'build',
  async writeBundle(options) {
    const out = options.dir ?? resolve(root, 'dist')
    await cp(resolve(root, 'examples/mario/img'), resolve(out, 'examples/mario/img'), { recursive: true })
  },
})

/** GitHub Pages runs Jekyll unless told not to, which would drop _-prefixed files. */
const noJekyll = (): Plugin => ({
  name: 'nonchalant:no-jekyll',
  apply: 'build',
  async writeBundle(options) {
    await writeFile(resolve(options.dir ?? resolve(root, 'dist'), '.nojekyll'), '')
  },
})

/** The gallery links to chat, which the static build does not carry. */
const chatIsLocalOnly = (): Plugin => ({
  name: 'nonchalant:chat-is-local-only',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler(html, ctx) {
      if (!ctx.path.endsWith('/examples/index.html')) return html
      return html.replace(
        /<li><a href="\.\/chat\/">chat<\/a>([\s\S]*?)<\/li>/,
        '<li>chat <span class="muted">— client-server; needs a local host, so it is not on the hosted' +
          ' site: clone the repo, run <code>pnpm chat-server</code>, then <code>pnpm dev</code></span></li>',
      )
    },
  },
})

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: pages.map((p) => resolve(root, p)) },
  },
  plugins: [marioSprites(), noJekyll(), chatIsLocalOnly()],
})
