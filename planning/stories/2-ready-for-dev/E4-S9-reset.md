---
id: E4-S9-reset
epic: E4-ID-identity-persistence
status: ready-for-dev
area: identify
touches: [browser]
depends_on: [E4-S3-durable-consent-lifecycle, E4-S5-anonymous-id-identity-resolver, E4-S8-session-id-expiry]
api_impact: additive
---

# E4-S9-reset — reset(options?) SPI verb: clear identity/persistence/session, keep device id, effective under opt-out

## Why

A consumer calls `reset()` on logout to clear the identified actor and start a fresh anonymous session — and it must stay effective even while opted out (a logout that silently kept identity would be a privacy footgun). This lands the reset transition across identity, persistence, and session.

## Scope

### In

- New SPI `reset(options?: { resetDevice?: boolean }): void` on `AnalyticsAdapter`; `NoopAdapter` no-ops it.
- Browser adapter `reset()`: regenerate the anonymous id (register_once a fresh distinct id), clear identity + persistence + session (`persistence.clear()`, state → anonymous, `resetSessionId()`), KEEP the device id unless `resetDevice` is passed.
- Widen the consumer-facing `AnalyticsProvider.reset()` → `reset(options?: { resetDevice?: boolean })` (additive/optional); the facade's empty `reset()` body delegates to `this.liveAdapter.reset(options)`.
- Reset routes to `liveAdapter` (not the consent-swapped `adapter`), so a logout during opt-out still clears identity; the live adapter's own consent posture (S3) keeps persistence suppressed, so no cookie is written.

### Out

- Orchestrating reset from the facade via `getPersistedProperty` / `setPersistedProperty` — rejected (leaks [WIRE] keys).
- Device-id regeneration by default — only on explicit `resetDevice`.

## Acceptance criteria

- [ ] The SPI grows `reset(options?)`; `NoopAdapter` satisfies it; the facade `reset(options?)` delegates to `liveAdapter.reset(options)`.
- [ ] `reset()` regenerates the anonymous id, clears identity/persistence/session; a subsequent `getDistinctId()` returns a NEW anonymous id.
- [ ] The device id is KEPT across `reset()`; `reset({ resetDevice: true })` regenerates it.
- [ ] `reset()` while opted-out still clears identity (routes to `liveAdapter`) AND writes no cookie (the live adapter's consent posture suppresses writes).
- [ ] The `AnalyticsProvider.reset()` signature is widened additively (existing zero-arg callers still compile — bar A).
- [ ] jsdom tests; grep clean; both packages' gates green.

## Technical notes

- **New SPI verb routed to the live adapter (Q4, — architect 2026-07-08):** reset is a multi-step transition against [WIRE] keys + stateful managers (`persistence.clear()`, state → anonymous, `register_once` a fresh distinct id keeping `$device_id`, `resetSessionId()`); facade-side KV orchestration would leak `distinct_id` / `$device_id` / `$sesid` into the neutral layer. Route to `liveAdapter`, NOT the consent-swapped `adapter`: a logout during opt-out must still clear identity (routing to the no-op would leave stale identity — a privacy footgun); the live adapter's consent posture (S3) keeps persistence suppressed. Widen consumer `reset()` → `reset(options?)` (additive).
- **Keeps the device id by default (— architect 2026-07-07):** regenerate the anon id; regenerate the device id only on an explicit `resetDevice` flag (PostHog's default keeps it).
- **Depends on S5 (identity + device id), S8 (session reset), S3 (opt-out-still-effective routing + write suppression).** S2's `persistence.clear()` is reached transitively via S5/S8.
- **SPI grows a required verb (— architect 2026-07-08):** additive to the CONSUMER API (`reset()` → `reset(options?)` is optional-arg widening); SPI-expanding — `NoopAdapter` no-ops.
- **Two shipped facade tests must be updated for the reset widening (refiner 2026-07-08):** (a) the `reset` signature type-pin in `analytics-provider.test.ts` (~line 379, currently `expectTypeOf<AnalyticsProvider['reset']>().toEqualTypeOf<() => void>()`) becomes `(options?: { resetDevice?: boolean }) => void`; the exact-match `keyof AnalyticsProvider` union is unchanged (no new member — only the signature widens; the member count is whatever S7 left it, having already added `register`/`unregister`). (b) the E2 skeleton test `'reset is a no-op skeleton in E2 — it touches no adapter verb'` (~line 202) is now SUPERSEDED: the facade `reset()` delegates to `liveAdapter.reset(options)`, so a spy adapter WILL see a `reset` call — rewrite that test to assert delegation instead of no-op.
- **SPI growth touches ALL in-repo adapter implementors (refiner 2026-07-08):** adding required `reset(options?)` breaks every `AnalyticsAdapter` implementor until updated — `NoopAdapter` (no-ops it) plus the five seam test doubles (`RecordingAdapter` ×3 in `analytics-provider.test.ts` / `adapter.test.ts` / `create-analytics.test.ts`, `SpyAdapter` ×2 in `allowlist.test.ts` / `allowlist-guard.test.ts`). Update them in this story to keep the 93 shipped tests typechecking/green.
- reference: `posthog-js/packages/browser/posthog-core.ts` `reset()`; de-brand.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->
