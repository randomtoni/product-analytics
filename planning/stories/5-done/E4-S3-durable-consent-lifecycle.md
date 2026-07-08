---
id: E4-S3-durable-consent-lifecycle
epic: E4-ID-identity-persistence
status: ready-for-dev
area: identify
touches: [browser, privacy]
depends_on: [E4-S1-browser-substrate-spike, E4-S2-persistence-store-modes]
api_impact: additive
---

# E4-S3-durable-consent-lifecycle — Durable tri-state consent + consent-first construction + lifecycle routing

## Why

E2 left opt-out in-memory only; a reload re-enabled capture and an unkeyed/opted-out client could still write cookies. This makes the opt-out decision durable, read FIRST at browser-adapter construction (before any cookie/domain-probe write), and locks the lifecycle-vs-consent routing so the whole-stack no-op E2 promised becomes real.

> **Sequencing note (PM 2026-07-08):** the epic's tentative slice list placed consent last; it is drafted here (before the cookie-domain probe, S4) because Q5a requires consent be read BEFORE the domain-probe write — so the S4 "no throwaway cookie when opted-out" AC is only testable once this consent-first gate exists. This is a PM slice-ordering call within the epic's locked decisions, not a re-litigation.

## Scope

### In

- SPI pair `getConsentState(): ConsentState` / `setConsentState(state: ConsentState)` on `AnalyticsAdapter`; `NoopAdapter.getConsentState()` returns `'denied'`, `setConsentState` no-ops.
- Neutral tri-state type `type ConsentState = 'granted' | 'denied' | 'pending'`, exported from the seam; never PostHog's numeric `{-1, 0, 1}`.
- The browser adapter reads consent FIRST at construction from a dedicated side-effect-free read (S2 low-level backend), BEFORE building the cookie/domain-probing persistence — an opted-out / default-denied / pending client writes zero cookies.
- Fold any platform Do-Not-Track / GPC signal INTO the resolved `getConsentState()` value inside the adapter (DNT is [WIRE]/platform mechanics, never a neutral-surface concept).
- Config consent-default field (the default deferred from E2-S5) resolving `'pending'` to a capture decision: `facade.optedOut = (resolved === 'denied')`.
- Facade: seed in-memory `optedOut` from `adapter.getConsentState()` at startup; delegate `optOut()` / `optIn()` to `setConsentState('denied')` / `setConsentState('granted')` for durability, keeping the no-op swap as the fast runtime gate.
- `optOut()` quiesces the live adapter (stop any timer/listener; DROP not flush the unsent buffer) and swaps the active delegate to the no-op (defense-in-depth); lifecycle `flush` / `shutdown` / `reset` stay routed to the live adapter (routing landed in S1).

### Out

- The persistence store itself — **S2**.
- Cookie domain / public-suffix probe (this story only ensures the probe is GATED by the consent-first read; the probe itself is **S4**).
- A real batching buffer to drop — **E5** (E4's browser adapter has no batch queue yet; `optOut()` quiesce is the contract, the buffer arrives in E5).

## Acceptance criteria

- [ ] `ConsentState = 'granted' | 'denied' | 'pending'` is exported neutral; no numeric consent encoding on any neutral surface.
- [ ] The SPI grows `getConsentState` / `setConsentState`; `NoopAdapter` satisfies them (`getConsentState()` → `'denied'`).
- [ ] The consent decision survives reload: setting `'denied'`, then reconstructing the adapter, reads back `'denied'` and writes zero cookies (including no domain-probe cookie).
- [ ] A `'pending'` (default/unasked) state writes zero cookies exactly like `'denied'`; only `'granted'` permits writes. `'pending'` resolves against `consentDefault` to set `facade.optedOut`; with `consentDefault` UNSET, pending resolves to denied (`optedOut = true`) — opt-out-by-default fail-safe (PM-decided). `consentDefault: 'granted'` + pending ⇒ capture runs, cookies still suppressed until an explicit grant.
- [ ] A platform DNT signal resolves into `getConsentState()` as denied — the neutral seam sees ONE resolved value, no DNT concept on the surface.
- [ ] The facade seeds `optedOut` from `getConsentState()` at startup; `optOut()` / `optIn()` persist via `setConsentState`; `hasOptedOut()` reflects the durable state after a reconstruct.
- [ ] `flush()` / `shutdown()` reach the live adapter even while opted-out (regression guard on S1's routing); `optOut()` drops rather than flushes.
- [ ] jsdom tests; `grep -ri posthog packages/browser/src packages/analytics-kit/src` clean; both packages' gates green.

## Technical notes

- **Consent is a tri-state enum, not a boolean (Q5, — architect 2026-07-08, high confidence):** a boolean can't separate "explicitly denied" from "not yet asked"; only `'granted'` writes cookies, so `'pending'` must write ZERO like denied. PostHog folds `doNotTrack` into denied (`consent.ts:29-31,122-131`) — resolve any platform DNT/GPC signal INTO `getConsentState()` inside the adapter. **Rejected:** boolean consent (can't express the pending state that gates whether any storage write happens).
- **Adapter-owned, read first, separate from main persistence (Q5a):** `create-analytics` hands the facade an already-constructed adapter, so the facade cannot own the "read before probe" guarantee — the browser adapter must read consent at ITS construction, before the domain-probe persistence exists. Use a dedicated side-effect-free read (S2 low-level backend), NOT the property store you're gating (circular).
- **Lifecycle routes to live; opt-out drops not flushes (Q5b):** `flush` / `shutdown` / `reset` → `liveAdapter` (landed S1). `optOut()` = `setConsentState('denied')` + quiesce (drop the unsent buffer — flushing would send data the user just declined) + swap the active delegate to the no-op. Keep get/set a PAIR (a single overloaded getter/setter is a JS anti-pattern).
- **Consent-default config field (finalized — refiner 2026-07-08):** add `consentDefault?: 'granted' | 'denied'` to `AnalyticsConfig` (additive, optional) — the opt-in-by-default vs opt-out-by-default knob that resolves a `'pending'` state. The facade resolves pending at seed time, so `consentDefault` must be available where `optedOut` is seeded (thread `config.consentDefault` into the facade the same additive way `allowlist`/`onViolation` already are). **Unset behavior (PM-decided 2026-07-08):** *When `consentDefault` is unset and durable consent is `'pending'`, capture resolves to **denied** (`facade.optedOut = true`): no events are captured and zero cookies are written until an explicit runtime opt-in or `consentDefault: 'granted'`. Opt-out-by-default is the library's fail-safe when no consent policy is configured.* `NoopAdapter.getConsentState()` → `'denied'` (safest — captures nothing regardless).
- **This SPI grows required verbs (— architect 2026-07-08):** additive to the CONSUMER API; SPI-expanding — `NoopAdapter` + the future node target satisfy the pair trivially.
- **SPI growth touches ALL in-repo adapter implementors, not just `NoopAdapter` (refiner 2026-07-08):** adding `getConsentState` / `setConsentState` as REQUIRED `AnalyticsAdapter` verbs breaks every existing implementor until updated. Beyond `NoopAdapter`, the seam test suite has five adapter test doubles that must gain the pair or the package stops typechecking: `RecordingAdapter` in `analytics-provider.test.ts`, `adapter.test.ts`, and `create-analytics.test.ts`, plus `SpyAdapter` in `allowlist.test.ts` and `allowlist-guard.test.ts`. Updating them is part of keeping the 93 shipped tests green.
- **Constructor seeding changes shipped facade behavior — keep the 93 tests green (refiner 2026-07-08):** seeding `optedOut` from `adapter.getConsentState()` runs in the `AnalyticsProviderImpl` constructor, so it fires for every existing facade test. The test doubles above must return a NON-denied state (e.g. `'granted'`) so `hasOptedOut()` still defaults to `false` and the E2-S5 opt-out/opt-in tests stay green. Consequence to confirm: `NoopAdapter.getConsentState()` returns `'denied'`, so an unkeyed `createAnalytics({}).hasOptedOut()` now reads `true` (was `false`) — safe (the no-op captures nothing regardless) but a behavior shift on the unkeyed path; the existing unkeyed tests (`flags`/`replay` undefined) don't assert capture, so they stay green.
- reference: `posthog-js/packages/browser/src/consent.ts`; de-brand (no `doNotTrack` / `$` on the seam).
- > Reviewer suggestion (2026-07-08, improvement-pass candidate): `resolveConsentBackend` falls back to `cookieBackend` when localStorage is unsupported — a non-granted client in a no-localStorage env writes ONE *consent* cookie (under `consentStoreName`). Reviewer agrees this is "the opposite of a tracking cookie" (a strictly-necessary preference cookie to REMEMBER opt-out is legitimate/privacy-correct). Pin the intended invariant with a one-line comment ("one consent-memory cookie is acceptable; it stores the opt-out, not tracking") — OR fall back to memory if literal-zero-cookies is required (costs opt-out durability in that env). Default: keep the consent cookie (durable opt-out is the privacy win).
- > Reviewer suggestion (2026-07-08, improvement-pass candidate): `consent.ts` comment claims "side-effect-free," but `resolveConsentBackend`→`localStorageBackend.isSupported()` does a write/read/remove probe at every construction. The consent VALUE read is side-effect-free; the capability probe is not. Tighten the comment for accuracy.

## Shipped

> Captured by `implement-epics` on 2026-07-08.

- **Files changed (seam):** `adapter.ts` (+`ConsentState` + SPI pair), `noop-adapter.ts` (pair: get→`'denied'`), `index.ts` (export `ConsentState`), `analytics-provider.ts` (constructor-seed `optedOut` via `resolveOptedOut`; `optOut/optIn` persist via `liveAdapter.setConsentState`), `create-analytics.ts` (+`AnalyticsConfig.consentDefault?`) + 5 test doubles updated
- **Files added (browser):** `consent.ts` (`platformDoNotTrack` + `ConsentStore`); **changed:** `browser-adapter.ts` (consent-first read gates persistence to memory unless granted; shared `memoryBackend`), `storage-backends.ts` (`resolveConsentBackend`), `persistence-keys.ts` (consent key)
- **New public API:** `ConsentState = 'granted'|'denied'|'pending'`; SPI `getConsentState()`/`setConsentState()`; `AnalyticsConfig.consentDefault?: 'granted'|'denied'`
- **Tests added:** seam +17 (consent SPI pin, facade seed/persist/reconstruct, drop-not-flush, consentDefault resolution) → 110; browser +19 (DNT, ConsentStore durability, consent-first zero-cookie, pending==denied) → 79
- **Commit:** `E4-S3-durable-consent-lifecycle — Durable tri-state consent + consent-first construction + lifecycle routing` on `core-cycle`
- **Reviewer notes:** 0 critical, 2 suggestions (both improvement-pass candidates: consent-cookie invariant note; "side-effect-free" comment accuracy)
- **Behavior shift (documented, safe):** unkeyed `createAnalytics({}).hasOptedOut()` now `true` (NoopAdapter→`'denied'`); a keyed browser client with no `consentDefault` + no prior consent is **opted-out by default** (pending⇒fail-safe denied). Consumers opt in via `consentDefault:'granted'` or runtime `optIn()`.
- **Cross-story seams exposed:** **S4** — the consent-first-read gate exists; the domain probe must live in the `cookie`/`localStorage+cookie` backend build path (reached only when `effectiveMode !== 'memory'`, i.e. granted), so opted-out/pending/DNT never writes a probe cookie (now testable). **S9** `reset()`→`liveAdapter` stays effective under opt-out. `ConsentStore` (separate name, side-effect-free value read) + shared `this.memoryBackend` available for S5/S8 pre-store reads. `optOut()` drops-not-flushes — E5's real buffer hooks that contract.
## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->
