---
name: Dynamic Registry Source Feature
description: Shared store + UI for runtime registry source selection (owner/repo/ref/path) on deploy and dashboard pages
type: project
---

Added dynamic strategy registry source selection in April 2026.

**New files:**

- `src/lib/services/registryLoader.ts` — pure types + URL resolver + parser +
  async loader
- `src/lib/stores/registrySource.ts` — shared Svelte store for source inputs and
  loaded registry

**Modified files:**

- `src/lib/services/orderDeployment.ts` — `buildOrderDeployment()` now accepts
  optional `LoadedRegistry` param; `buildGui()` uses it when provided instead of
  static URL
- `src/routes/+page.svelte` — registry source section UI (owner/repo/ref/path
  inputs + Load Registry button), `availableStrategies` computed from loaded
  registry, `buildOrder` passes loaded registry to deployment service
- `src/routes/dashboard/+page.svelte` — readonly registry source indicator bar,
  `hydrateFromStorage()` called in onMount

**Key design:**

- Static config fallback is always active when registry not loaded
- localStorage key: `st0x_registrySource`
- `loadedRegistry` Svelte store = null (not loaded) or `LoadedRegistry` result
- Strategy availability: filters `STRATEGIES` by those where every
  `order.strategyType` exists in registry entries
- fetchCache in orderDeployment.ts still works (keyed by URL)

**Why:** Allow deploying from different registry sources (e.g., different git
branches/commits) without changing tokens.yaml
