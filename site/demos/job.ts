// One long-running job where the pieces meet: a durable process on a "worker",
// served over the wire to this page, with streamed progress, a cancel, an
// approval gate answered through call(), and two ways to break it — pull the
// client off the network, or kill the worker. The worker, its journal, and the
// destination it writes into all run in this tab, so nothing needs a server.
//
// Time arrives from outside: the page passes real timers, and the site's test
// passes the same timers sped up.

import { mount } from '@nonchalant/dom'
import { realClock, type Clock } from '../../examples/job/job.ts'
import { rig } from '../../examples/job/rig.ts'
import { JobApp } from '../../examples/job/view.ts'

export function run(host: Element, clock: Clock = realClock()): Disposable {
  const world = rig(clock)
  const view = mount(host, JobApp(world))
  return {
    [Symbol.dispose]: () => {
      view[Symbol.dispose]()
      world[Symbol.dispose]()
    },
  }
}
