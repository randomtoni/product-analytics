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
- [ ] A `'pending'` (default/unasked) state writes zero cookies exactly like `'denied'`; only `'granted'` permits writes. `'pending'` resolves against the config consent-default to set `facade.optedOut`.
- [ ] A platform DNT signal resolves into `getConsentState()` as denied — the neutral seam sees ONE resolved value, no DNT concept on the surface.
- [ ] The facade seeds `optedOut` from `getConsentState()` at startup; `optOut()` / `optIn()` persist via `setConsentState`; `hasOptedOut()` reflects the durable state after a reconstruct.
- [ ] `flush()` / `shutdown()` reach the live adapter even while opted-out (regression guard on S1's routing); `optOut()` drops rather than flushes.
- [ ] jsdom tests; `grep -ri posthog packages/browser/src packages/analytics-kit/src` clean; both packages' gates green.

## Technical notes

- **Consent is a tri-state enum, not a boolean (Q5, — architect 2026-07-08, high confidence):** a boolean can't separate "explicitly denied" from "not yet asked"; only `'granted'` writes cookies, so `'pending'` must write ZERO like denied. PostHog folds `doNotTrack` into denied (`consent.ts:29-31,122-131`) — resolve any platform DNT/GPC signal INTO `getConsentState()` inside the adapter. **Rejected:** boolean consent (can't express the pending state that gates whether any storage write happens).
- **Adapter-owned, read first, separate from main persistence (Q5a):** `create-analytics` hands the facade an already-constructed adapter, so the facade cannot own the "read before probe" guarantee — the browser adapter must read consent at ITS construction, before the domain-probe persistence exists. Use a dedicated side-effect-free read (S2 low-level backend), NOT the property store you're gating (circular).
- **Lifecycle routes to live; opt-out drops not flushes (Q5b):** `flush` / `shutdown` / `reset` → `liveAdapter` (landed S1). `optOut()` = `setConsentState('denied')` + quiesce (drop the unsent buffer — flushing would send data the user just declined) + swap the active delegate to the no-op. Keep get/set a PAIR (a single overloaded getter/setter is a JS anti-pattern).
- **Consent-default config field:** add the opt-in-by-default vs opt-out-by-default field to `AnalyticsConfig` (additive) that resolves `'pending'`. Name it neutrally (e.g. `consentDefault?: 'granted' | 'denied'`); the story-refiner may finalize the exact key. `NoopAdapter.getConsentState()` → `'denied'` (safest — captures nothing regardless).
- **This SPI grows required verbs (— architect 2026-07-08):** additive to the CONSUMER API; SPI-expanding — `NoopAdapter` + the future node target satisfy the pair trivially.
- reference: `posthog-js/packages/browser/src/consent.ts`; de-brand (no `doNotTrack` / `$` on the seam).

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->
