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
  - `evaluate(context?)` resolves the cached/loaded `FlagSet`; when `context.distinctId` is absent, fill it from the browser's current identity. **Handoff: reach identity via the public adapter SPI `BrowserAdapter.getDistinctId()` (`browser-adapter.ts:903`, which delegates to the in-memory `IdentityStore.getDistinctId()` at `identity-store.ts:68`) — NOT the `IdentityStore` directly (it is a `private` member of `BrowserAdapter`, `browser-adapter.ts:209`, unreachable from a separate flag-adapter module).** Give the flag adapter a `getDistinctId: () => string` reference (or the `BrowserAdapter` handle) at construction so identity stays a single source of truth; do not mint or cache a second distinct id. A `refresh: true` on the `evaluate` options forces a re-fetch — **S1 PINNED the folded shape; there is NO separate `reload` method** (a fire-and-forget refresh is `evaluate({ refresh: true })` whose promise the caller may ignore).
  - Remote fetch of the flag set at init + on refresh, de-branded from `posthog-featureflags.ts` (the `/decide`- / `/flags`-style flag-eval request). Endpoint, request body (the vendor `$feature`/`distinct_id`/`groups`/person+group-props wire keys), and response shape are `[WIRE]`, adapter-internal — mapped from/to the neutral `FlagContext`/`FlagSet` at the adapter boundary. Follow the SHIPPED browser wire convention: `[WIRE]`-commented plain consts (e.g. `GZIP_CONTENT_TYPE`/`COMPRESSION_WIRE_VALUE` in `transport-wire.ts`), NOT a literal `$`-named variable — the `$`-prefixed strings are the vendor wire VALUES held in those consts, never neutral-facing symbol names.
  - In-memory cache of the resolved set; `onChange` listeners fire when the async set arrives and re-fire on refresh (browser cardinality = re-firing, per S1).
  - Bootstrap seeding: read `config.flags.bootstrap.{flags,payloads}` and seed the cache **synchronously at construction** so the FIRST `evaluate()`/sync read returns the bootstrap set before the network fetch resolves (de-branded from the browser reference `initialize()` at `posthog-js/packages/browser/src/posthog-featureflags.ts:339`).
  - Populate `provider.flags` — the browser `createAnalytics` wires this adapter into the already-declared optional `flags?` slot when keyed; unkeyed leaves it `undefined` (no flag machinery, bar B).
  - Map the neutral degradation signal: set `FlagSet.degraded` / `reason(key)` from the adapter's own knowledge of fetch success/failure/staleness (a failed fetch that falls back to bootstrap/stale cache is `degraded: true`, not a silent all-`false`). Vendor eval-quality fields stay adapter-internal. **For the `'unresolved'` state (a failed fetch with NO bootstrap/stale fallback), return the seam's canonical `emptyFlagSet()` (S1, imported from `analytics-kit`) — do NOT hand-roll a second empty `FlagSet` impl** (it would drift from the seam null-object snapshot S5 also uses).
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
- [ ] `onChange` fires once on first async arrival and re-fires on `evaluate({ refresh:true })` (there is NO `reload` method — folded into `evaluate`, S1-pinned); the returned unsubscribe stops further calls.
- [ ] `evaluate()` with no `context.distinctId` fills it from the current browser identity; an explicit `context.distinctId` overrides.
- [ ] A failed/aborted fetch sets `FlagSet.degraded = true` and a neutral `reason` from the S1-pinned union (`'stale'` when a prior cached/bootstrap set is served after the failed refresh; `'unresolved'` when nothing is available) — the consumer can distinguish a real "off" from a failed round-trip; no vendor eval-quality field leaks onto the snapshot. A bootstrap-served first read (before any fetch) reads `reason` = `'bootstrap'`; a fresh network arrival reads `'resolved'`.
- [ ] Taxonomy typing flows: with a typed `config.taxonomy` declaring `flags`, `provider.flags.getPayload(key)` / `getFlag(key)` narrow per the declared `variants`/`payload` (a type-test).
- [ ] Neutrality: `grep -ri posthog ts/packages/browser/src` clean; wire tokens confined to `$`-const / `[WIRE]` internals; `pnpm neutrality-scan` green.
- [ ] Gates green: `pnpm --filter @analytics-kit/browser build test typecheck lint`; tests use a mock fetch, never a live backend.

## Technical notes

- reference: `posthog-js/packages/browser/src/posthog-featureflags.ts` — the remote flag-eval request, the persistence cache, the `onFeatureFlags` listener, and `initialize()` bootstrap seeding. De-brand: strip `$feature*`/`ph_`/`posthog` from every neutral-facing name; endpoint + request/response shapes become `[WIRE]` adapter internals mapped from `FlagContext`/to `FlagSet`. Consult `posthog-source-guide` for the exact browser fetch/cache/bootstrap mechanics before porting.
- **Bootstrap synchronous seeding is the whole point** — it must land in the cache at construction, before any `evaluate()` could run, so the first sync read is the bootstrap set (the flash-of-wrong-variant only exists client-side). The config field is S1; consuming it is here.
- **`distinctId` optional on browser (— architect 2026-07-10):** the adapter fills it from current identity; person/group props come from the browser's own mechanism when the consumer doesn't pass them per-`evaluate`. This is the browser half of the E4 `sessionId` asymmetry — no fake ambient actor.
- **`degraded`/`reason` mapping (— architect 2026-07-10):** the adapter is the ONLY place that knows fetch succeeded/failed/served-stale — it sets the neutral signal. **The `FlagReason` union is S1-PINNED to `'resolved' | 'bootstrap' | 'stale' | 'unresolved'` — do NOT invent a new member here.** Map the browser's real states onto those four: bootstrap-served-before-fetch ⇒ `'bootstrap'`; network-arrived ⇒ `'resolved'`; failed refresh falling back to a prior set ⇒ `'stale'`; failed with no fallback ⇒ `'unresolved'` (+ `degraded: true`). If S2 genuinely discovers a fifth state the four can't express, the fix goes BACK to S1's type and re-propagates to S3/S4 in the same change — never a browser-only union widening.
- **Wire-vocabulary fence:** the flag-eval endpoint path, the request body keys (`distinct_id`, `groups`, `$feature/*`), and the response payload shape are confined to `[WIRE]`-commented plain consts (the shipped `transport-wire.ts` convention), never a literal `$`-named symbol, and never on the neutral `FlagContext`/`FlagSet`/config surface. `pnpm neutrality-scan` treats non-doc `//` provenance comments specially (CLAUDE.md exemption) but scans symbol names — keep every wire token a const VALUE, not a name. `hogql` is not involved here.
- **Narrowest test path (— refine):** browser adapter tests are runtime, jsdom/mock-fetch (never a live backend) — mirror `browser-adapter.test.ts` / `transport.test.ts` mock-fetch harness. The bootstrap-sync-read-before-fetch-resolves test is the load-bearing one (an un-resolved fetch mock + a `config.flags.bootstrap` ⇒ first `evaluate()` returns the bootstrap set with `reason: 'bootstrap'`). Taxonomy narrowing is a separate `expectTypeOf` type-test (mirror the seam's S1 type-test).

> Reviewer suggestion (2026-07-10): Bootstrap seeds falsy flags/payloads verbatim, whereas the reference `initialize()` filters to active flags. Observable `isEnabled` is identical, so this is a deliberate neutral choice, not an oversight — no change needed; recorded so a future reader doesn't "fix" it toward the reference's filtering.

## Shipped

> Captured by `implement-epics` on 2026-07-10.

- **Files changed:** `ts/packages/browser/src/create-analytics.ts` (+ `.test.ts`) — the `attachFlags()` `provider.flags` slot wiring (mirrors `registerCountry`; keyed ⇒ attach, unkeyed ⇒ slot `undefined`)
- **Files added:** `ts/packages/browser/src/feature-flags.ts` (the `FlagClient<TX>` browser adapter), `ts/packages/browser/src/feature-flags.test.ts` (16 tests)
- **New public API:** none — `FlagClient` (+ `FlagAdapterOptions`/`FlagFetchOptions`/`FlagWireResponse`) is adapter-internal, never exported from the package index. The only observable addition is the filled `provider.flags` slot (the S1 `FeatureFlagPort`).
- **Tests added:** `feature-flags.test.ts` (16: bootstrap sync-seed → `reason:'bootstrap'`, fetch → `'resolved'`, failed-refresh-serving-prior → `'stale'`, failed-no-fallback → S1 `emptyFlagSet()` `'unresolved'`, `onChange` re-fire cardinality, `getDistinctId()` identity, and the retry-added forced-refresh-with-new-context regression); +4 in `create-analytics.test.ts`
- **Commit:** `main` (message = story title)
- **Reviewer notes:** shipped on retry 1. First review found 1 critical (`refresh:true` coalesced onto a stale in-flight fetch, dropping a new context — green-but-uncovered, no test used a non-`undefined` context with `refresh:true`). Fixed with an explicit `force` flag that chains a guaranteed follow-up fetch carrying the NEW context (mirrors the reference's `_additionalReloadRequested`); mutation-verified (revert → new test fails "only 1 fetch"; restore → 16 pass). Re-review traced every `refresh` branch: critical closed, no regression. 1 suggestion captured above (deliberate no-change).
- **Retry history:** 1 retry (cap was 2). The critical: forced-refresh context-drop; fixed + regression-tested.
- **Cross-story seams exposed:** S5 (React hook) — `onChange` fires on each committed set (first network arrival + every forced refresh; NOT on register or the sync bootstrap seed), so the hook reads the initial snapshot via `evaluate()` (serves bootstrap/cache synchronously) and subscribes via `onChange`; absent `provider.flags` (unkeyed) → fall back to the seam `emptyFlagSet()` (same null-object this adapter serves for `'unresolved'`). S6 (proof) — `FrozenFlagMembers='evaluate'|'onChange'` ready for the `capability-presence.ts` pin; bar-B via `config.flags.bootstrap`; bar-A mock-swap clean (consumers touch only the neutral port). **S3/S4 warning (doc-commented in `feature-flags.ts`):** the non-forced in-flight coalescing is browser-only-safe (single-sourced identity) — a SERVER target where per-call `distinctId`/props vary must fetch per call, not share a wire body.
