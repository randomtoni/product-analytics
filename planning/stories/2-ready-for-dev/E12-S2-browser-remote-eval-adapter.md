---
id: E12-S2-browser-remote-eval-adapter
epic: E12-FF-flag-substrate-remote-eval
status: ready-for-dev
area: feature-flags
touches: [browser]
depends_on: [E12-S1]
api_impact: additive
---

# E12-S2-browser-remote-eval-adapter — Browser remote-eval flag adapter (TS)

## Why

With the port pinned (S1), the browser target implements the first real flag adapter: fetch the flag set at init + on refresh, cache it, seed it from config bootstrap synchronously to kill the flash-of-wrong-variant, and fire `onChange` when the async set arrives. This is the browser half of **bar A** — the neutral `FeatureFlagPort` satisfied by a browser adapter that fills `distinctId` from current identity.

## Scope

### In

- **Browser flag adapter module (`ts/packages/browser/src/feature-flags.ts` or similar, named by role)** — a class implementing the S1 `FeatureFlagPort`:
  - `evaluate(context?)` resolves the cached/loaded `FlagSet`; when `context.distinctId` is absent, fill it from the browser's current identity (the identity-store distinct id). A `refresh: true` (or a separate `reload`, per S1's carve-out) forces a re-fetch.
  - Remote fetch of the flag set at init + on refresh, de-branded from `posthog-featureflags.ts` (the `/decide`-style flag-eval request). Endpoint, request body (`$feature`/`distinct_id`/`groups`/person+group props), and response shape are `[WIRE]`, adapter-internal — mapped from/to the neutral `FlagContext`/`FlagSet` at the adapter boundary (`$`-const for wire tokens).
  - In-memory cache of the resolved set; `onChange` listeners fire when the async set arrives and re-fire on refresh (browser cardinality = re-firing, per S1).
  - Bootstrap seeding: read `config.flags.bootstrap.{flags,payloads}` and seed the cache **synchronously at construction** so the FIRST `evaluate()`/sync read returns the bootstrap set before the network fetch resolves (de-branded from the browser reference `initialize()` at `posthog-js/packages/browser/src/posthog-featureflags.ts:339`).
  - Populate `provider.flags` — the browser `createAnalytics` wires this adapter into the already-declared optional `flags?` slot when keyed; unkeyed leaves it `undefined` (no flag machinery, bar B).
  - Map the neutral degradation signal: set `FlagSet.degraded` / `reason(key)` from the adapter's own knowledge of fetch success/failure/staleness (a failed fetch that falls back to bootstrap/stale cache is `degraded: true`, not a silent all-`false`). Vendor eval-quality fields stay adapter-internal.
- **Browser `createAnalytics` wiring (`ts/packages/browser/src/create-analytics.ts`)** — construct + attach the flag adapter to the provider's `flags` slot when keyed; pass through `config.flags.bootstrap`. Config-only, no seam edit.
- **Tests** — against a mock fetch (never a real backend): bootstrap-seeded sync read before fetch resolves; `onChange` fires on async arrival + re-fires on refresh; `distinctId` filled from identity when absent; `degraded`/`reason` set on a failed fetch; taxonomy-typed `getPayload`/`getFlag` narrowing exercised through a typed config.

### Out

- **Node / Python remote adapters** — S3 / S4 (same neutral port, different target).
- **Local (in-process) eval** — E13.
- **The React hook** — S5.
- **`setPersonPropertiesForFlags` / `setGroupPropertiesForFlags` stateful setters** — deferred; person/group props ride per-`evaluate` in `FlagContext`, never stashed on the adapter.
- **`$feature_flag_called` exposure auto-capture** — out of the epic; reading a flag emits NO analytics event and attaches NO flag context to other events.
- **Client-side test overrides (`overrideFeatureFlags`), encrypted remote-config payloads, early-access enrollment** — PostHog-product surface, not neutral primitives.

## Acceptance criteria

- [ ] The browser flag adapter satisfies the S1 `FeatureFlagPort` exactly (`evaluate` + `onChange`; `FlagSet` sync reads + degradation signal). A keyed browser `createAnalytics(config)` populates `provider.flags`; an unkeyed one leaves it `undefined`.
- [ ] Bootstrap seeds synchronously: with `config.flags.bootstrap` supplied and the network mock un-resolved, the first `evaluate()` resolves to (and sync reads off) the bootstrap set — no flash-of-wrong-variant. When the fetch later resolves, `onChange` fires with the network set.
- [ ] `onChange` fires once on first async arrival and re-fires on `evaluate({ refresh:true })` (or `reload`); the returned unsubscribe stops further calls.
- [ ] `evaluate()` with no `context.distinctId` fills it from the current browser identity; an explicit `context.distinctId` overrides.
- [ ] A failed/aborted fetch sets `FlagSet.degraded = true` and a neutral `reason` (e.g. `'stale'`/`'unresolved'`) — the consumer can distinguish a real "off" from a failed round-trip; no vendor eval-quality field leaks onto the snapshot.
- [ ] Taxonomy typing flows: with a typed `config.taxonomy` declaring `flags`, `provider.flags.getPayload(key)` / `getFlag(key)` narrow per the declared `variants`/`payload` (a type-test).
- [ ] Neutrality: `grep -ri posthog ts/packages/browser/src` clean; wire tokens confined to `$`-const / `[WIRE]` internals; `pnpm neutrality-scan` green.
- [ ] Gates green: `pnpm --filter @analytics-kit/browser build test typecheck lint`; tests use a mock fetch, never a live backend.

## Technical notes

- reference: `posthog-js/packages/browser/src/posthog-featureflags.ts` — the remote flag-eval request, the persistence cache, the `onFeatureFlags` listener, and `initialize()` bootstrap seeding. De-brand: strip `$feature*`/`ph_`/`posthog` from every neutral-facing name; endpoint + request/response shapes become `[WIRE]` adapter internals mapped from `FlagContext`/to `FlagSet`. Consult `posthog-source-guide` for the exact browser fetch/cache/bootstrap mechanics before porting.
- **Bootstrap synchronous seeding is the whole point** — it must land in the cache at construction, before any `evaluate()` could run, so the first sync read is the bootstrap set (the flash-of-wrong-variant only exists client-side). The config field is S1; consuming it is here.
- **`distinctId` optional on browser (— architect 2026-07-10):** the adapter fills it from current identity; person/group props come from the browser's own mechanism when the consumer doesn't pass them per-`evaluate`. This is the browser half of the E4 `sessionId` asymmetry — no fake ambient actor.
- **`degraded`/`reason` mapping (— architect 2026-07-10):** the adapter is the ONLY place that knows fetch succeeded/failed/served-stale — it sets the neutral signal. Confirm the exact neutral `FlagReason` members here (S1 left them provisional): the browser's real states (bootstrap-served, network-resolved, stale-cache, unresolved) drive the union; feed any refinement back to S1's type in the same PR only if the trees still agree.
- **Wire-vocabulary fence:** the flag-eval endpoint path, the request body keys (`distinct_id`, `groups`, `$feature/*`), and the response payload shape are confined to `$`-const / `_WIRE_*`-style internals — never on the neutral `FlagContext`/`FlagSet`/config surface. `hogql` is not involved here.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/. Do not hand-edit. -->
