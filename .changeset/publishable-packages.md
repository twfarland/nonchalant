---
'@nonchalant/core': minor
'@nonchalant/dom': minor
'@nonchalant/wire': minor
'@nonchalant/durable': minor
'@nonchalant/host': minor
---

Every package builds to `dist/` (ES modules plus `.d.ts`), and `@nonchalant/core` is a peer dependency of dom, wire, durable, and host, so an application holds exactly one copy of the runtime.
