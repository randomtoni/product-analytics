---
id: E2-S4-factory-and-noop-adapter
epic: E2-CORE-provider-seam
status: ready-for-dev
area: core
touches: [adapters]
depends_on: [E2-S2-analytics-adapter-spi, E2-S3-analytics-provider-facade]
api_impact: additive
---

# E2-S4-factory-and-noop-adapter — `createAnalytics` factory machinery + whole-stack `NoopAdapter`

## Why

The config-selected factory is bar B ("new-app adoption = config only, zero library change") made real — a consumer wires the library by config alone. The whole-stack `NoopAdapter` makes "unkeyed ⇒ silent" a type-level guarantee, not an `if (disabled)` scattered through the facade.

## Scope

### In

- `NoopAdapter` in the seam (`packages/analytics-kit/src/`): a null-object implementing the **full** `AnalyticsAdapter` SPI (S2) as silent no-ops — `capture`/`identify`/`group`/`alias` do nothing; `flush`/`shutdown` resolve; `getPersistedProperty` returns `undefined`; `setPersistedProperty` is a no-op; `fetch` **resolves a neutral empty response** (see below); client-identity getters return neutral placeholders. **Whole-stack**: identity/persistence/session all go to the memory/no-op path, not just transport.
- `createAnalytics(config, adapter?)` factory **machinery** in the seam: wires an `AnalyticsProvider` facade (S3) to whichever adapter it is handed; when no key is configured (or no adapter is provided), it falls back to the `NoopAdapter` and returns a silent facade. Returns the facade.
- A minimal `AnalyticsConfig` type carrying at least `key?: string` (its presence/absence drives no-op selection). Keep it minimal and additive-extensible (E3 adds taxonomy/allowlist, E4 cookie domain, E5 ingest host).
- Export `createAnalytics`, `NoopAdapter`, and `AnalyticsConfig` from the seam's public surface.

### Out

- Any **target** adapter (browser E5 / node E7) and the target packages' own config-selected entries — the seam **never imports a target adapter** (see Technical notes). E2's factory only exercises selection down to the `NoopAdapter`.
- Consent's opt-out routing to the no-op — **S5** (S4 builds the `NoopAdapter` that S5 routes to).
- Real transport/persistence in any non-noop adapter (E5/E7).
- Optional `flags?`/`replay?` slots — **S6**.

## Acceptance criteria

- [ ] `createAnalytics({})` (no `key`) returns a facade whose captures are silent — a spy placed on the wire path receives nothing; no cookie/persistence write occurs (the no-op is whole-stack).
- [ ] `createAnalytics(config, adapter)` wires the facade to the supplied adapter and delegates to it (the generic machinery works with any SPI-satisfying adapter).
- [ ] `NoopAdapter` satisfies the **entire** `AnalyticsAdapter` SPI — every verb and platform primitive is present and silent; there is **no** `disabled` boolean threaded through the facade.
- [ ] The seam package declares **no** dependency on any `@analytics-kit/*` target (inward-only rule preserved); `grep` confirms no target import in the factory.
- [ ] Bar B is demonstrable: a consumer obtains a working (silent) provider by config alone, with zero library edit.
- [ ] `pnpm --filter analytics-kit typecheck`, `lint`, `test`, `build` all exit 0.
- [ ] `grep -ri posthog packages/analytics-kit/src` is clean.

## Technical notes

- **Whole-stack null-object, NOT a `disabled` flag (— architect 2026-07-07):** PostHog threads `disabled = options.disabled ?? false || missingApiKey` through its one class (`posthog-js/packages/core/src/posthog-core-stateless.ts:287`). We deliberately don't — a `NoopAdapter` null-object keeps `if (disabled)` checks from spreading and makes "unkeyed ⇒ silent" a type-level guarantee. The no-op must be **whole-stack**: identity/persistence/session also go to memory mode (this couples to E4, which implements the memory-persistence half — E2 fixes the *reach*, not the persistence mechanics).
- **Factory placement vs. inward-only deps (epic Notes, 2026-07-07 — load-bearing):** the seam ships the factory **machinery** — a generic `createAnalytics(config, adapter)` that wires a facade to whichever adapter it is handed — but the seam package **never imports a target adapter** (E1's inward-only rule). Each **target** package (browser/node, later) exports the consumer-facing config-selected entry (`import { createAnalytics } from "@analytics-kit/browser"`) that passes its *own* adapter in, falling back to the seam's `NoopAdapter` when unkeyed. "Selects the adapter from config" means this two-piece shape — **not** seam-side imports of targets. E2 builds only the seam's generic half + the `NoopAdapter`; the only selection E2 can exercise is unkeyed ⇒ `NoopAdapter`.
- **`AnalyticsConfig` stays minimal:** E2 needs only enough to drive no-op selection (`key?`). Every later area extends it additively — E3 (taxonomy/allowlist), E4 (cookie domain/scope, persistence mode), E5 (ingestHost/ingestPath). Do not pre-stub those fields; add them when their epic lands.
- **Adapter-arg shape is a sketch, not frozen:** whether `createAnalytics` takes a single adapter, an adapter factory, or an adapter set can firm up when the first target entry (E5/E7) supplies a real adapter. Keep E2's signature the simplest thing that lets the target packages hand their adapter in; note it as refinable.
- **`NoopAdapter.fetch` must satisfy the SPI's return type (code-shape pin):** S2 types `fetch` as `Promise<NeutralFetchResponse>`, so the no-op cannot return `void`/`undefined` — resolve a neutral empty response, e.g. `Promise.resolve({ status: 0, text: async () => '', json: async () => ({}) })` (matching S2's `NeutralFetchResponse` = `{ status; text(); json() }`). `getPersistedProperty` returns `undefined`; `getCustomUserAgent` returns `undefined`; `getLibraryId`/`getLibraryVersion` return neutral placeholder strings (they are `: string`, so `''` or a neutral constant — never a vendor token).
- **Factory wires the S3 internal facade class:** `createAnalytics` resolves the adapter (supplied arg, else `NoopAdapter` when unkeyed/none) and constructs the internal facade class from S3 (`new AnalyticsProviderImpl(resolvedAdapter)`), returning it typed as the public `AnalyticsProvider` interface. Import the facade class **internally** (not through the public barrel); the factory is the only public way to obtain a provider.

## Shipped
