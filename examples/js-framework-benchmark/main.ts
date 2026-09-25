// Mounts the benchmark app (bench.ts) into the harness page.

import { spawn } from '@nonchalant/core'
import { mount } from '@nonchalant/dom'
import { App, rows, selection, type Row, type Selection } from './bench.ts'

const store = spawn(rows, undefined, { initial: [] as Row[] })
const selected = spawn(selection, undefined, { initial: {} as Selection })
mount(document.getElementById('main')!, App(store, selected))
