// `?inspect` on a gallery page docks the process inspector along the bottom.
// Import it first: the sink records only processes spawned after it is
// installed, and an import runs before the importing module's body.

import { mountInspector } from '@nonchalant/inspect'

if (new URLSearchParams(location.search).has('inspect')) {
  const dock = document.createElement('aside')
  dock.style.cssText = 'position:fixed;inset:auto 0 0 0;max-height:45vh;overflow:auto;z-index:1000'
  document.body.append(dock)
  document.body.style.paddingBottom = '45vh'
  mountInspector(dock)
}
