// Build config for the static site: the documentation pages at the root, plus
// the example gallery under /examples/. `pnpm dev` is unaffected — this file
// only adds build inputs, so the dev server still serves the repo as before.
//
// Deployed with `vite build --base=/nonchalant/` (see .github/workflows/pages.yml).

import { writeFileSync } from 'node:fs'
import { cp, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultClientConditions, defaultServerConditions, defineConfig, type Plugin } from 'vite'
import { renderDocs } from './site/docs.ts'
import { sitePages } from './site/pages.ts'

const root = dirname(fileURLToPath(import.meta.url))

/** The markdown in docs/ as site pages, written beside their sources (gitignored) so dev and build both serve them. */
const writeDocs = (): string[] => {
  const docs = renderDocs(root)
  for (const [path, html] of docs) writeFileSync(resolve(root, path), html)
  return [...docs.keys()]
}
const docPages = writeDocs()

// Every page that runs in the browser alone. `examples/chat/` is deliberately
// absent: it dials ws://127.0.0.1:4322 at module scope, and constructing an
// insecure WebSocket from an https page throws outright, which would leave the
// page blank rather than merely disconnected. It stays a run-it-locally demo.
const pages = [
  ...sitePages,                                  // the documentation site
  ...docPages,                                   // docs/*.md, rendered
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
  'examples/worker/index.html',
  'examples/agent/index.html',
  'examples/multi-agent/index.html',
  'examples/delegation/index.html',
  'examples/messaging/index.html',
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

/** In dev, an edited doc re-renders and the page reloads. */
const liveDocs = (): Plugin => ({
  name: 'nonchalant:live-docs',
  apply: 'serve',
  configureServer(server) {
    server.watcher.on('change', (file) => {
      if (!/[\\/]docs[\\/].*\.md$/.test(file)) return
      writeDocs()
      server.ws.send({ type: 'full-reload' })
    })
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
  // the `source` export condition points @nonchalant/* at src/*.ts, so the
  // site and the examples build from source rather than from a stale dist/
  resolve: { conditions: ['source', ...defaultClientConditions] },
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
  build: {
    // mermaid is a lazy chunk: only readers who expand a diagram pay for it
    chunkSizeWarningLimit: 1_500,
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: pages.map((p) => resolve(root, p)) },
  },
  plugins: [liveDocs(), marioSprites(), noJekyll(), chatIsLocalOnly()],
})
