// Every demo a page can show, by the id its `data-demo` slot names. Each is
// loaded only by a page that has its slot. Every source listed is imported
// twice — once as code that runs, once as text that is displayed — so a listing
// can never drift from the thing above it. Demos that reach into a module of
// their own (mario's physics, the agent's loop, the worker's grinder) list that
// file too: the interesting part is not always in the file that mounts.

import type { Source } from './sources.ts'

export interface Demo {
  run(host: Element): Disposable
  sources: Source[]
}

type Raw = Promise<{ default: string }>

const load = async (
  mod: Promise<{ run(host: Element): Disposable }>,
  files: [label: string, src: Raw][],
): Promise<Demo> => ({
  run: (await mod).run,
  sources: await Promise.all(files.map(async ([label, src]) => ({ label, src: (await src).default }))),
})

export const demos: Record<string, () => Promise<Demo>> = {
  counter: () => load(import('./demos/counter.ts'), [['counter.ts', import('./demos/counter.ts?raw')]]),
  todos: () => load(import('./demos/todos.ts'), [['todos.ts', import('./demos/todos.ts?raw')]]),
  typeahead: () => load(import('./demos/typeahead.ts'), [['typeahead.ts', import('./demos/typeahead.ts?raw')]]),
  form: () => load(import('./demos/form.ts'), [['form.ts', import('./demos/form.ts?raw')]]),
  drag: () => load(import('./demos/drag.ts'), [['drag.ts', import('./demos/drag.ts?raw')]]),
  shared: () => load(import('./demos/shared.ts'), [['shared.ts', import('./demos/shared.ts?raw')]]),
  worker: () =>
    load(import('./demos/worker.ts'), [
      ['worker.ts', import('./demos/worker.ts?raw')],
      ['primes.ts — the process', import('../examples/worker/primes.ts?raw')],
      ['grind.worker.ts — the host', import('./demos/grind.worker.ts?raw')],
    ]),
  mario: () =>
    load(import('./demos/mario.ts'), [
      ['mario.ts — the process and the view', import('../examples/mario/mario.ts?raw')],
      ['demo.ts — mounting it', import('./demos/mario.ts?raw')],
    ]),
  agent: () =>
    load(import('./demos/agent.ts'), [
      ['agent.ts — the loop', import('../examples/agent/agent.ts?raw')],
      ['tools.ts — tools as processes', import('../examples/agent/tools.ts?raw')],
      ['demo.ts — the page', import('./demos/agent.ts?raw')],
    ]),
}
