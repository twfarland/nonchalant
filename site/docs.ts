// The markdown in docs/ as pages of this site, so the documentation reads with
// the same navigation, type, and highlighting as everything else. Rendering is
// pure: vite.config.ts writes the pages next to their sources (docs/**/*.html,
// gitignored) and builds them, and site.test.ts checks their links with the
// hand-written pages'. The markdown stays the source of truth, and it still
// reads correctly on GitHub: anchors follow GitHub's slugs, and links to
// anything outside docs/ go to the repository.

import { readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { Marked } from 'marked'

const REPO = 'https://github.com/twfarland/nonchalant'

/** The documents in reading order: file under docs/, short label, one-line summary. */
export const docOrder: readonly (readonly [file: string, label: string, blurb: string])[] = [
  ['tutorial.md', 'Tutorial', 'Thinking in processes: build a cart locally, then move it to a server.'],
  ['concepts.md', 'Concepts', 'Each concept, its exact behavior, and the tests that enforce it.'],
  ['api.md', 'API', 'Every export of every package, with its signature.'],
  ['recipes.md', 'Recipes', 'Typeahead, forms, a query cache, routing, undo and redo, drag, durable processes.'],
  ['migration.md', 'Migration', 'How ideas from React, Solid, and LiveView map over, and what you give up.'],
  ['errors.md', 'Errors', 'Crashes, stale values, rejected calls, and render and connection failures.'],
  ['testing.md', 'Testing', 'Driving generators directly and checking their messages and yields.'],
  ['inspect.md', 'Inspector', 'The instrumentation hook, the recorder, time travel, and the panel.'],
  ['server.md', 'Server', 'Durable execution, timers, the storage interface, agents, and their limits.'],
  ['hosting.md', 'Hosting', 'Origins, authorization, per-connection scope, message screening, and limits.'],
  ['PROTOCOL.md', 'Protocol', 'The eight-message wire protocol and its conformance rules.'],
  ['internals/README.md', 'Internals', 'Notes for contributors on how the core works and what it guarantees.'],
]

/** Where a markdown file is published: `docs/x.md` → `docs/x.html`, a README → its folder's index. */
export const docPath = (md: string): string =>
  md.replace(/(^|\/)README\.md$/, '$1index.html').replace(/\.md$/, '.html')

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const plain = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

/** GitHub's heading anchors, so a link written for github.com lands in the same place here. */
const slugger = (): ((text: string) => string) => {
  const seen = new Map<string, number>()
  return (text) => {
    const base = text.toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N} _-]/gu, '').replace(/ /g, '-')
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}-${n}`
  }
}

/** A link as written in `from` (repo-relative), as it must be written on the published page. */
const resolveLink = (href: string, from: string): string => {
  if (/^[a-z][a-z+.-]*:/i.test(href) || href.startsWith('#')) return href
  const [, path = '', rest = ''] = /^([^?#]*)(.*)$/.exec(href) ?? []
  const target = posix.normalize(posix.join(posix.dirname(from), path)).replace(/\/$/, '')
  if (target.startsWith('docs/') && target.endsWith('.md')) {
    return posix.relative(posix.dirname(from), docPath(target)) + rest
  }
  const kind = /\.[a-z0-9]+$/i.test(target) ? 'blob' : 'tree'
  return `${REPO}/${kind}/master/${target}${rest}`
}

interface Rendered {
  title: string
  body: string
  sections: { id: string; text: string }[]
}

const render = (file: string, source: string): Rendered => {
  const slug = slugger()
  const sections: { id: string; text: string }[] = []
  let title = ''
  const marked = new Marked({ gfm: true })
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens)
        const text = plain(inner)
        if (depth === 1) {
          if (title === '') title = text
          return `<h1>${inner}</h1>\n`
        }
        const id = slug(text)
        if (depth === 2) sections.push({ id, text })
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`
      },
      link({ href, title: hint, tokens }) {
        const inner = this.parser.parseInline(tokens)
        const attr = hint === null || hint === undefined ? '' : ` title="${escape(hint)}"`
        return `<a href="${escape(resolveLink(href, file))}"${attr}>${inner}</a>`
      },
      code({ text, lang }) {
        const kind = (lang ?? '').split(/\s+/)[0]
        if (kind === 'mermaid') {
          return `<details class="diagram"><summary>Diagram</summary><div class="diagram-body"><pre data-mermaid>${escape(text)}</pre></div></details>\n`
        }
        const ts = kind === 'ts' || kind === 'tsx' ? ' data-ts' : ''
        return `<pre><code${ts}>${escape(text)}</code></pre>\n`
      },
    },
  })
  const body = marked
    .parse(source, { async: false })
    .replace(/<table>/g, '<div class="scroll"><table>')
    .replace(/<\/table>/g, '</table></div>')
  return { title, body, sections }
}

const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23131312'/%3E%3Cpath d='M9 22V10l14 12V10' stroke='%23F5F5F4' stroke-width='2.5' fill='none' stroke-linecap='square'/%3E%3C/svg%3E"

/** One page of the site around `main`, with links made relative to `path`. */
const shell = (path: string, title: string, description: string, main: string): string => {
  const here = posix.dirname(path)
  const up = '../'.repeat(path.split('/').length - 1)
  const link = (target: string): string => posix.relative(here, target) || '.'
  const docLinks = [['docs/index.html', 'Contents'] as const, ...docOrder.map(([file, label]) => [docPath(`docs/${file}`), label] as const)]
    .map(([target, label]) => {
      const current = target === path || (label === 'Internals' && here === 'docs/internals') ? ' aria-current="page"' : ''
      return `<a href="${link(target)}"${current}>${label}</a>`
    })
    .join('\n  ')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Nonchalant</title>
<meta name="description" content="${escape(description)}">
<link rel="icon" href="${ICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,300..700;1,6..72,300..600&display=swap">
<link rel="stylesheet" href="${up}site/styles.css">
</head>
<body>

<div class="page">

<nav class="topnav" aria-label="Site">
  <a class="brand" href="${up}">NONCHALANT</a>
  <a href="${up}">Overview</a>
  <a href="${up}guide.html">Guide</a>
  <a href="${up}anywhere.html">Run anywhere</a>
  <a href="${up}server.html">Server &amp; agents</a>
  <a href="${up}examples/">Examples</a>
  <span class="spacer"></span>
  <a href="${up}docs/" aria-current="page">Docs</a>
  <a href="${REPO}">GitHub</a>
</nav>

<nav class="docnav" aria-label="Documentation">
  ${docLinks}
</nav>

${main}

<footer>
  Nonchalant is experimental alpha software: a TypeScript runtime for stateful async-generator processes.<br>
  MIT © Tim Farland · <a href="${REPO}">github.com/twfarland/nonchalant</a>
</footer>

</div>

<script type="module" src="${up}site/main.ts"></script>
</body>
</html>
`
}

const docPage = (file: string, source: string): string => {
  const { title, body, sections } = render(file, source)
  const toc =
    sections.length < 3
      ? ''
      : `<ol class="toc">\n${sections.map((s) => `  <li><a href="#${s.id}">${s.text === '' ? s.id : escape(s.text)}</a></li>`).join('\n')}\n</ol>\n`
  const main = `<article class="doc">
${body.replace('</h1>\n', `</h1>\n${toc}`)}
<p class="doc-source"><a href="${REPO}/blob/master/${file}">This page's source on GitHub</a></p>
</article>`
  return shell(docPath(file), title, `${title}: Nonchalant documentation.`, main)
}

const indexPage = (titles: Map<string, string>): string => {
  const rows = docOrder
    .map(([file, , blurb]) => {
      const title = titles.get(`docs/${file}`) ?? file
      return `      <tr><td><a href="${posix.relative('docs', docPath(`docs/${file}`))}">${escape(title)}</a></td><td>${escape(blurb)}</td></tr>`
    })
    .join('\n')
  const main = `<header class="mast sub" id="top">
  <div class="eyebrow">Documentation</div>
  <h1>Documentation</h1>
  <p class="deck">Reference and how-to material, in more depth than the <a href="../guide.html">guide</a>. Claims about performance and granularity point at the tests that enforce them.</p>
</header>

<section>
  <div class="scroll">
  <table>
    <thead><tr><th>Document</th><th>What it covers</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  </div>
</section>`
  return shell('docs/index.html', 'Documentation', 'The Nonchalant documentation: tutorial, concepts, API reference, recipes, and more.', main)
}

/** Every page under docs/, keyed by its repo-relative output path. */
export function renderDocs(root = '.'): Map<string, string> {
  const files = readdirSync(join(root, 'docs'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f.replace(/\\/g, '/')}`)
    .sort()
  const pages = new Map<string, string>()
  const titles = new Map<string, string>()
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8')
    titles.set(file, /^# (.+)$/m.exec(source)?.[1] ?? file)
    pages.set(docPath(file), docPage(file, source))
  }
  pages.set('docs/index.html', indexPage(titles))
  return pages
}
