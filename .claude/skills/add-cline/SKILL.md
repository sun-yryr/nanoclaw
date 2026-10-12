---
name: add-cline
description: >-
  Fork-local Cline agent provider already present in this install. Headless
  refresh is a no-op that only verifies the in-tree registration files exist.
metadata:
  nanoclaw-provider: cline
  nanoclaw-provider-label: Cline
  nanoclaw-provider-offered: 'false'
---

# Cline agent provider (fork-local)

This install carries Cline as a fork customization under `src/providers/cline.ts`
and `container/agent-runner/src/providers/cline.ts`. There is no registry
payload on the `providers` branch to copy.

## Refresh

Confirm the in-tree provider files are still present. Do not overwrite them.

```nc:run effect:refresh
test -f src/providers/cline.ts && test -f container/agent-runner/src/providers/cline.ts && test -f src/providers/index.ts && grep -q "import './cline.js'" src/providers/index.ts && grep -q "import './cline.js'" container/agent-runner/src/providers/index.ts
```
