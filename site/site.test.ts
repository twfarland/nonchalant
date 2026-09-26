// @vitest-environment happy-dom
//
// The site's demos are documentation that executes, so a demo that stops
// rendering is a broken doc page. This mounts each one the way the page does
// and drives the interactions the captions promise.

import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { flush } from '@nonchalant/core'
import { docOrder, renderDocs } from './docs.ts'
import { demos } from './demos.ts'
import { highlight } from './highlight.ts'
import { sitePages } from './pages.ts'
import { showSources } from './sources.ts'
import { run as counter } from './demos/counter.ts'
import { run as todos } from './demos/todos.ts'
import { run as typeahead } from './demos/typeahead.ts'
import { run as form } from './demos/form.ts'
import { run as drag } from './demos/drag.ts'
import { run as shared } from './demos/shared.ts'
import { run as worker } from './demos/worker.ts'
import { run as mario } from './demos/mario.ts'
import { run as agent } from './demos/agent.ts'
import { run as job } from './demos/job.ts'
import { realClock } from '../examples/job/job.ts'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const host = (): HTMLElement => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

const settle = async (): Promise<void> => {
  await tick()
  flush()
}

describe('site demos', () => {
  it('counter counts both ways, and same-tick clicks queue instead of racing', async () => {
    const el = host()
    counter(el)
    await settle()
    const [minus, plus] = [...el.querySelectorAll('button')]
    expect(el.querySelector('.count')?.textContent).toBe('0')

    plus?.click()
    await settle()
    expect(el.querySelector('.count')?.textContent).toBe('1')

    // three clicks in one tick: deltas queue in the mailbox and all three land,
    // which a read-modify-write (`cast(count() - 1)`) would lose
    minus?.click()
    minus?.click()
    minus?.click()
    await settle()
    expect(el.querySelector('.count')?.textContent).toBe('-2')
  })

  it('todos renders its seed rows, adds, toggles, and removes', async () => {
    const el = host()
    todos(el)
    await settle()
    expect(el.querySelectorAll('li').length).toBe(2)

    const field = el.querySelector('input[type="text"]') as HTMLInputElement
    field.value = 'write the docs'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()
    expect(el.querySelectorAll('li').length).toBe(3)
    expect(field.value).toBe('') // the field clears itself

    const secondRow = el.querySelectorAll('li')[1] as HTMLElement
    ;(secondRow.querySelector('input[type="checkbox"]') as HTMLInputElement).click()
    await settle()
    expect(secondRow.querySelector('span')?.getAttribute('class')).toBe('done')

    ;(secondRow.querySelector('button') as HTMLButtonElement).click()
    await settle()
    expect(el.querySelectorAll('li').length).toBe(2)
  })

  it('typeahead starts empty and searches on input', async () => {
    const el = host()
    typeahead(el)
    await settle()
    expect(el.querySelector('.muted')?.textContent).toBe('0 matches')

    const field = el.querySelector('input') as HTMLInputElement
    field.value = 'berry'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(el.querySelector('.muted')?.textContent).toBe('searching…')

    await new Promise((resolve) => setTimeout(resolve, 500)) // the fake API's latency
    flush()
    expect(el.querySelectorAll('li').length).toBeGreaterThan(0)
  })

  it('typeahead cancels a search that a newer query overtakes, and never shows its answer', async () => {
    const el = host()
    typeahead(el)
    await settle()
    const field = el.querySelector('input') as HTMLInputElement
    const type = (q: string): void => {
      field.value = q
      field.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

    type('l')
    await wait(200)
    type('lem')
    await wait(300) // past the first search's 400ms: it would have answered by now
    flush()
    expect(el.querySelector('.muted')?.textContent).toBe('searching…')
    expect(el.querySelectorAll('li').length).toBe(0)

    await wait(200)
    flush()
    expect([...el.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['clementine', 'lemon'])
  })

  it('form replies to call() with the outcome, both ways', async () => {
    const el = host()
    form(el)
    await settle()
    expect(el.querySelector('.readout')?.textContent).toBe('awaiting submit')

    const field = el.querySelector('input') as HTMLInputElement
    const submit = el.querySelector('button') as HTMLButtonElement

    field.value = 'nope'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    submit.click()
    await new Promise((resolve) => setTimeout(resolve, 800))
    flush()
    expect(el.querySelector('.readout')?.textContent).toBe('that is not an email')

    field.value = 'me@example.com'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    submit.click()
    await new Promise((resolve) => setTimeout(resolve, 800))
    flush()
    expect(el.querySelector('.readout')?.textContent).toBe('signed up')
  })

  it('drag renders a draggable box', async () => {
    const el = host()
    drag(el)
    await settle()
    expect(el.querySelector('.dragfield')).not.toBeNull()
    expect(el.querySelector('.dragbox')?.textContent).toBe('drag me')
  })

  it('shared state: two panels built apart move together', async () => {
    const el = host()
    shared(el)
    await settle()
    const readout = (): string => el.querySelector('.readout')?.textContent ?? ''
    expect(readout()).toBe('0 items · $0')

    const add = [...el.querySelectorAll('button')].find((b) => b.textContent === 'add boots')
    add?.click()
    await settle()
    expect(readout()).toBe('1 item · $120') // panel two saw panel one's message
    expect(el.querySelectorAll('li').length).toBe(1)

    const clear = [...el.querySelectorAll('button')].find((b) => b.textContent === 'clear')
    clear?.click()
    await settle()
    expect(readout()).toBe('0 items · $0')
  })

  // no Worker in a DOM shim, so this exercises the demo's other host: the same
  // registry exposed in this thread over a MessageChannel. What is under test
  // is that the page's code path does not care which one it got.
  it('worker: the grinder is reached over a port and counts up', async () => {
    const el = host()
    const demo = worker(el)
    await settle()
    const readout = (): string => el.querySelector('.readout')?.textContent ?? ''
    expect(readout()).toBe('0 tested · 0 primes · last —')

    const start = [...el.querySelectorAll('button')].find((b) => b.textContent === 'grind primes')
    start?.click()
    await new Promise((resolve) => setTimeout(resolve, 300)) // a couple of chunks
    flush()
    expect(Number(readout().split(' ')[0])).toBeGreaterThan(0)

    const stop = [...el.querySelectorAll('button')].find((b) => b.textContent === 'stop')
    stop?.click()
    await settle()
    demo[Symbol.dispose]()
  })

  // the claim the section around it makes: this is the same machinery as the
  // counter above, so it is tested the same way
  it('agent: reaches for a tool, streams an answer, and parks on approval', async () => {
    const el = host()
    const demo = agent(el)
    await settle()
    const answer = (): string => {
      const answers = [...el.querySelectorAll('.turn.answer .said')]
      return answers[answers.length - 1]?.textContent ?? ''
    }
    const waitFor = async (ready: () => boolean, what: string): Promise<void> => {
      for (let i = 0; i < 500 && !ready(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 4))
        flush()
      }
      if (!ready()) throw new Error(`never reached: ${what}`)
    }
    expect(el.querySelectorAll('.turn').length).toBe(0)
    expect(el.querySelector('.gate')).toBeNull() // nobody is being asked anything yet

    const press = (label: string): void => {
      const b = [...el.querySelectorAll('button')].find((x) => x.textContent === label)
      b?.click()
    }
    press('ask') // the field starts on "what is a patch?"
    await waitFor(() => el.querySelectorAll('.turn').length >= 2, 'the tool call')
    expect(el.querySelectorAll('.turn')[1]?.textContent).toContain('search')
    await waitFor(() => answer().includes('patches'), 'the streamed answer')
    // exactly one tool: a question that is a lookup is not also arithmetic
    expect(el.querySelectorAll('.turn.tool').length).toBe(1)

    // and the tool that waits for a person: no reply, no progress
    const field = el.querySelector('input') as HTMLInputElement
    field.value = 'refund 20'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await settle() // the field's cell takes a turn to publish, like any process
    press('ask')
    await waitFor(() => el.textContent?.includes('approve refund 20?') === true, 'the approval request')
    expect(el.querySelector('.gate')).not.toBeNull()
    press('yes')
    await waitFor(() => answer().includes('approved'), 'the decision to reach the agent')
    expect(el.querySelector('.gate')).toBeNull() // and it goes away again

    demo[Symbol.dispose]()
  }, 20_000) // a stubbed model still takes its time, on purpose

  // the page's own clock, twenty times faster: the demo takes its time as an argument
  it('job: streams progress, goes stale while partitioned, survives a worker kill at the gate, and writes each record once', async () => {
    const el = host()
    const demo = job(el, realClock(0.05))
    const text = (sel: string): string => el.querySelector(sel)?.textContent ?? ''
    const rows = (status: string): number => el.querySelectorAll(`.job-rec.${status}`).length
    const press = (label: string): void => {
      const b = [...el.querySelectorAll('button')].find((x) => x.textContent === label)
      if (b === undefined) throw new Error(`no button "${label}"`)
      b.click()
    }
    const waitFor = async (ready: () => boolean, what: string): Promise<void> => {
      for (let i = 0; i < 1000 && !ready(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 4))
        flush()
      }
      if (!ready()) throw new Error(`never reached: ${what}`)
    }

    await waitFor(() => text('.job-state') === 'idle · 0 of 12', 'the first snapshot over the wire')
    press('start import')
    await waitFor(() => rows('written') >= 1, 'the first record')

    press('disconnect client')
    await waitFor(() => text('.job-flag').startsWith('stale'), 'the stale flag')
    // the statuses come over the wire; the tallies beside them are the
    // destination's own, read directly, so they keep moving
    const statuses = (): string => [...el.querySelectorAll('.job-status')].map((s) => s.textContent).join(' ')
    const frozen = statuses()
    await new Promise((resolve) => setTimeout(resolve, 120)) // the worker writes on; nothing crosses
    flush()
    expect(statuses()).toBe(frozen)
    expect(el.querySelector('.job-tally')?.textContent).toContain('wrote 1×')
    press('reconnect client')
    await waitFor(() => text('.job-flag') === 'live' && statuses() !== frozen, 'the catch-up')

    await waitFor(() => el.querySelector('.gate') !== null, 'the approval gate')
    press('kill worker')
    await waitFor(() => text('.job-flag').startsWith('stale'), 'the worker gone')
    press('restart worker')
    await waitFor(() => text('.job-flag') === 'live' && el.querySelector('.gate') !== null, 'the gate, restored from the journal')
    press('approve')
    await waitFor(() => text('.job-state') === 'done · 12 of 12', 'the end')

    const tallies = [...el.querySelectorAll('.job-tally')].map((t) => t.textContent ?? '')
    expect(tallies).toHaveLength(12)
    expect(tallies.every((t) => t.includes('wrote 1×'))).toBe(true) // never twice, whatever ran twice
    expect(el.querySelectorAll('.job-tape li').length).toBeGreaterThan(0)
    demo[Symbol.dispose]()
  }, 20_000)

  it('mario: the stage owns its keyboard and the sprite tracks the walk', async () => {
    const el = host()
    const demo = mario(el)
    await settle()
    const stage = el.querySelector('.mariostage') as HTMLElement
    const sprite = (): string => el.querySelector('img')?.getAttribute('src') ?? ''
    expect(stage.getAttribute('tabindex')).toBe('0') // arrows belong to the stage, not the page
    expect(sprite()).toContain('stand/left')

    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 120)) // a few animation frames
    flush()
    expect(sprite()).toContain('walk/right')
    const left = el.querySelector('img')?.getAttribute('style') ?? ''
    expect(left).toContain('left: ')

    stage.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 120))
    flush()
    expect(sprite()).toContain('stand/right')
    demo[Symbol.dispose]()
  })
})

// The page draws these with mermaid the first time a reader expands one, which
// means a syntax error would show up as an empty box in production and nowhere
// else. Parsing them here is the cheapest possible guard.
describe('source listings', () => {
  const slot = (): Element => {
    const root = document.createElement('div')
    root.innerHTML = '<details><summary>source</summary><pre><code data-src></code></pre></details>'
    document.body.appendChild(root)
    return root
  }

  it('one file gets no tabs', () => {
    const root = slot()
    showSources(root, [{ label: 'only.ts', src: 'const a = 1' }])
    expect(root.querySelector('.src-tabs')).toBeNull()
    expect(root.querySelector('[data-src]')?.textContent).toBe('const a = 1')
  })

  it('several files get tabs, and clicking one shows it', () => {
    const root = slot()
    showSources(root, [
      { label: 'demo.ts', src: 'const mounted = true' },
      { label: 'process.ts', src: 'const interesting = true' },
    ])
    const tabs = [...root.querySelectorAll('.src-tab')] as HTMLButtonElement[]
    expect(tabs.map((t) => t.textContent)).toStrictEqual(['demo.ts', 'process.ts'])
    expect(tabs[0]?.className).toContain('on')
    expect(root.querySelector('[data-src]')?.textContent).toContain('mounted')

    tabs[1]?.click()
    expect(root.querySelector('[data-src]')?.textContent).toContain('interesting')
    expect(tabs[1]?.className).toContain('on')
    expect(tabs[0]?.className).not.toContain('on')
  })
})

// the hand-written pages, plus docs/*.md as the build renders them (the
// rendered files are gitignored, so they are rendered here rather than read)
const pages = new Map<string, string>([
  ...sitePages.map((page) => [page, readFileSync(page, 'utf8')] as const),
  ...renderDocs(),
])

// A multi-page site breaks quietly: a renamed anchor or a moved demo shows up
// as a dead link or an empty box, never as an error. These read the pages as
// text and check what they point at.
describe('the pages', () => {
  it('link only to files and anchors that exist', () => {
    let checked = 0
    for (const [page, html] of pages) {
      for (const [, href = ''] of html.matchAll(/href="([^"]+)"/g)) {
        if (/^[a-z]+:/.test(href)) continue // off-site
        const [, path = '', fragment = ''] = /^([^?#]*)(?:\?[^#]*)?(?:#(.*))?$/.exec(href) ?? []
        let target = path === '' ? page : posix.normalize(posix.join(posix.dirname(page), path))
        if (path.endsWith('/') || target === '.') target = posix.join(target, 'index.html')
        expect(pages.has(target) || existsSync(target), `${page}: ${href}`).toBe(true)
        if (fragment !== '') {
          const doc = pages.get(target) ?? readFileSync(target, 'utf8')
          expect(doc.includes(`id="${fragment}"`), `${page}: ${href}`).toBe(true)
        }
        checked++
      }
    }
    expect(checked).toBeGreaterThan(200)
  })

  it('list every document in docs/ on the documentation contents', () => {
    const listed = new Set(docOrder.map(([file]) => file))
    const top = readdirSync('docs').filter((f) => f.endsWith('.md'))
    expect(top.filter((f) => !listed.has(f))).toStrictEqual([])
    expect(listed.has('internals/README.md')).toBe(true)
  })

  it('name only demos that exist, and every demo appears on some page', () => {
    const shown = new Set<string>()
    for (const [page, html] of pages) {
      for (const [, id = ''] of html.matchAll(/data-demo="([^"]+)"/g)) {
        expect(demos[id], `${page}: ${id}`).toBeDefined()
        shown.add(id)
      }
    }
    expect([...shown].sort()).toStrictEqual(Object.keys(demos).sort())
  })
})

describe('the architecture diagrams', () => {
  it('are valid mermaid', async () => {
    const sources = [...pages.values()].flatMap((html) =>
      [...html.matchAll(/<pre data-mermaid>([\s\S]*?)<\/pre>/g)].map((m) =>
        // the entities decoded, as the browser's textContent hands them to mermaid
        (m[1] ?? '')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .trim()))
    expect(sources.length).toBeGreaterThan(0)

    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({ startOnLoad: false })
    for (const source of sources) {
      // throws on a bad one, naming the diagram so it can be found
      await mermaid.parse(source).catch((e: unknown) => {
        throw new Error(`${String(e)}\nin the diagram:\n${source}`)
      })
    }
    await expect(mermaid.parse('flowchart LR; A[[[broken')).rejects.toBeTruthy() // and a bad one fails
  }, 30_000)
})

describe('the plain highlighter', () => {
  it('marks keywords, strings, and comments', () => {
    expect(highlight('const x = 1')).toBe('<span class="k">const</span> x = 1')
    expect(highlight("'hi'")).toBe('<span class="s">\'hi\'</span>')
    expect(highlight('// note')).toBe('<span class="c">// note</span>')
  })

  it('escapes markup so source can never become HTML', () => {
    expect(highlight('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d')
    expect(highlight('"<script>"')).toBe('<span class="s">"&lt;script&gt;"</span>')
  })

  it('does not find keywords inside strings or comments', () => {
    expect(highlight("'const'")).toBe('<span class="s">\'const\'</span>')
    expect(highlight('// const')).toBe('<span class="c">// const</span>')
    expect(highlight('constant')).toBe('constant') // whole words only
  })

  it('handles escaped quotes and unterminated comments without hanging', () => {
    expect(highlight("'it\\'s'")).toBe('<span class="s">\'it\\\'s\'</span>')
    expect(highlight('/* open')).toBe('<span class="c">/* open</span>')
  })
})
