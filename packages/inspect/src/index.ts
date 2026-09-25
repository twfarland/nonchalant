// @nonchalant/inspect — a recorder over core's instrument() hook, and a panel
// that renders it: the process tree, a timeline of messages, yields and
// patches, and time travel by replaying patches from a process's spawn state.

export { inspect, record, clear, stateAt, tree, summarize, draft, empty, recorder } from './record.ts'
export type { Draft, Entry, ProcNode, Recording, TreeNode, RecorderMsg, InspectOptions, Inspector } from './record.ts'
export { mountInspector, describe, uiProc } from './panel.ts'
export type { MountedInspector, Ui, UiMsg } from './panel.ts'
