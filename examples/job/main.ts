// The page: the rig at real speed, and the view over it. The worker, the
// cable, the journal, and the destination all live in this tab, so the static
// site can run it; job.test.ts drives the same rig with a hand-turned clock.

import { mount } from '@nonchalant/dom'
import { realClock } from './job.ts'
import { rig } from './rig.ts'
import { JobApp } from './view.ts'

mount(document.getElementById('app')!, JobApp(rig(realClock())))
