---
id: E4-S5-anonymous-id-identity-resolver
epic: E4-ID-identity-persistence
status: ready-for-dev
area: identify
touches: [browser]
depends_on: [E4-S1-browser-substrate-spike, E4-S2-persistence-store-modes]
api_impact: additive
---

# E4-S5-anonymous-id-identity-resolver — Anonymous id + device id + adapter-internal identity state + getDistinctId resolver

## Why

Every browser event needs a stable actor before `identify()` is ever called. This mints and persists the anonymous distinct id and a separate device id, models identity state explicitly inside the adapter, and replaces the facade's stubbed `currentDistinctId()` via a new SPI resolver.

## Scope

### In

- A UUIDv7 anonymous/distinct id minted at first load (via S1's crypto generator), persisted (S2), reused across reloads.
- A separate persisted device id minted once at first load, stored under its OWN key (retention-across-`reset()` behavior is S9; S5 just mints/persists it separately).
- Explicit neutral identity state `anonymous | identified` INSIDE the browser adapter (never the wire `distinct_id === $device_id` trick). Adapter-internal; NO public identity-state getter this epic.
- SPI `getDistinctId(): string` — a cheap synchronous in-memory read (the adapter loads persistence once at init and caches; it does NOT hit storage per event). `NoopAdapter.getDistinctId()` returns the `'anonymous'` constant, moved DOWN from the facade.
- Facade `currentDistinctId()` becomes `return this.liveAdapter.getDistinctId()` (reads `liveAdapter`, not the consent-swapped `adapter` — identity is orthogonal to consent).
- A pluggable device-id generator (swap the id scheme without touching identity semantics).

### Out

- The anon→identified merge + traits — **S6**.
- `reset()` / device-id retention-on-reset — **S9**.
- Session id — **S8**.
- A public identity-state getter — not this epic (open-Q closed: adapter-internal only).

## Acceptance criteria

- [ ] An anonymous UUIDv7 distinct id is generated at first load, persisted, and reused across a reconstruct (reload).
- [ ] A device id is minted once and persisted as a SEPARATE key from the distinct id.
- [ ] SPI `getDistinctId()` returns the current distinct id from an in-memory cache (no per-call storage read); `NoopAdapter.getDistinctId()` returns `'anonymous'`.
- [ ] The facade `currentDistinctId()` delegates to `liveAdapter.getDistinctId()`; the `ANONYMOUS_DISTINCT_ID` constant no longer lives in the facade (moved to `NoopAdapter`).
- [ ] While opted-out, `getDistinctId()` still returns the truthful distinct id (reads `liveAdapter`, not the no-op).
- [ ] Identity state (`anonymous | identified`) is adapter-internal; no `$`-prefixed name and no id-equality trick on any neutral surface; no public state getter is exported.
- [ ] The device-id generator is injectable; jsdom tests; `grep -ri posthog packages/browser/src packages/analytics-kit/src` clean; both packages' gates green.

## Technical notes

- **Facade delegates, adapter owns state (Q1, — architect 2026-07-08):** add SPI `getDistinctId()` (cheap in-memory read); facade `currentDistinctId()` → `this.liveAdapter.getDistinctId()` — the one-method swap E2's consolidation anticipated (`buildEvent` + `setTraits` already route through `currentDistinctId()`, so this is pure population, no `NeutralEvent` reshape). Read from `liveAdapter` (identity orthogonal to consent). **Rejected:** facade orchestrating via `getPersistedProperty('distinct_id')` — leaks the [WIRE] key name into the neutral facade (bar-A break).
- **Explicit neutral state, wire encoding stays in the adapter (— architect 2026-07-07):** the neutral surface carries `anonymous | identified`; the `distinct_id === $device_id` trick and `$device_id` / `distinct_id` [WIRE] keys are normalized inside the adapter. No public state getter this epic (open-Q closed, — architect 2026-07-08).
- **Device id separate + survives reset (— architect 2026-07-07):** minted once, stored under its own key; S9 keeps it across `reset()` unless `resetDevice`.
- **Cross-dependency for S6 (Q2):** the facade's `setTraits` calls `adapter.identify(currentDistinctId(), ...)`, so S6's merge correctness is gated on THIS resolver shipping — with the stub returning `'anonymous'`, `setTraits` could mis-trigger a merge. S5 must land before S6.
- **Merge-retention forward-pointer (— architect 2026-07-08):** persist the id under its own key so S6 can retain the prior anon id at merge (`posthog-core.ts:374`).
- **SPI grows a required verb (— architect 2026-07-08):** additive to the CONSUMER API; SPI-expanding — `NoopAdapter` returns `'anonymous'`, a future node target returns its own neutral placeholder.
- **SPI growth touches ALL in-repo adapter implementors (refiner 2026-07-08):** adding required `getDistinctId(): string` breaks every existing `AnalyticsAdapter` implementor until updated. Beyond `NoopAdapter` (returns the moved-down `'anonymous'` constant), update the five seam test doubles — `RecordingAdapter` in `analytics-provider.test.ts` / `adapter.test.ts` / `create-analytics.test.ts` and `SpyAdapter` in `allowlist.test.ts` / `allowlist-guard.test.ts` (they can just return `'anonymous'`) — or the package stops typechecking and the 93 shipped tests break.
- reference: `posthog-js/packages/core` identity + `packages/browser` persistence; de-brand.
- > Reviewer suggestion (2026-07-08, improvement-pass candidate): `identity-store.ts` class-doc comment describes PostHog's seed-equal (distinct id == device id) behavior, but the code mints them as two INDEPENDENT ids (deliberately dropped the id-equality trick). Stale/misleading — reword or remove so a future reader can't "restore" the equality on the comment's authority.
- > Reviewer suggestion (2026-07-08, improvement-pass candidate / S6-S9): `IdentityStore.getDeviceId()` does an unchecked `as string` cast + a per-call storage read; currently uncalled (forward-use for S6/S9). Defer to the slice that consumes it or guarantee presence rather than cast.
- > Reviewer suggestion (2026-07-08): `deviceIdGenerator` is on `BrowserAdapterOptions` but not plumbed through `AnalyticsConfig`/`resolveAdapter` — injectable at the adapter seam (satisfies the AC) but not via consumer `createAnalytics({key})`. Defensible scope line (config-surface decision, later slice); flagged as a conscious boundary.

## Shipped

> Captured by `implement-epics` on 2026-07-08.

- **Files changed (seam):** `adapter.ts` (+`getDistinctId()` SPI), `noop-adapter.ts` (satisfy + owns `'anonymous'` constant), `analytics-provider.ts` (`currentDistinctId()`→`liveAdapter.getDistinctId()`, constant removed) + 5 test doubles
- **Files added (browser):** `identity-store.ts` (mint anon v7 id + separate device id, explicit `anonymous|identified` state, in-memory distinctId cache, injectable device-id generator); **changed:** `browser-adapter.ts` (construct IdentityStore + `getDistinctId` delegate + `deviceIdGenerator?`), `persistence-keys.ts` (+`IdentityState` type/constants)
- **New public API:** SPI `getDistinctId(): string` (`NoopAdapter`→`'anonymous'`). Identity state, device id, IdentityStore all adapter-internal (no public getter).
- **Tests added:** seam +2 facade delegation (opted-out truthful) → 113; browser +14 (identity-store 9, adapter 5) → 94
- **Commit:** `E4-S5-anonymous-id-identity-resolver — Anonymous id + device id + adapter-internal identity state + getDistinctId resolver` on `core-cycle`
- **Reviewer notes:** 0 critical, 3 suggestions → see Technical notes (ported PostHog's explicit `$user_state` MODEL, not the id-equality trick — went further with fully independent ids)
- **Cross-story seams exposed:** `IdentityStore` (adapter-internal) persists explicit `anonymous|identified` under `IDENTITY_STATE_KEY` + caches `distinctId` in memory. **S6 merge:** guard reads `getIdentityState()` (merge only when new id differs AND state `anonymous`); flips to `IDENTIFIED_IDENTITY_STATE`; persist prior anon id under the reserved (unwritten) `ANONYMOUS_DISTINCT_ID_KEY`; update the cached `distinctId` field in lockstep with `DISTINCT_ID_KEY`. **S9 reset:** regenerate distinct id + clear state, KEEP `DEVICE_ID_KEY` unless `resetDevice` (re-mint via `deviceIdGenerator`); update the cache. **S8 session:** untouched — stamps `sessionId` in `stampSessionId()` pass-through hook.
## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->

## Follow-up

> E4 post-close improvement pass, 2026-07-08 (commit follows). Reviewer-verified, no regression.

- **Stale seed-equal doc removed** — `identity-store.ts` class-doc reworded to "two INDEPENDENT ids; the seed-equal trick is deliberately dropped" so a future reader can't restore the equality.
- **`getDeviceId()` cast dropped** — return type widened `string` → `string | undefined`, unchecked `as string` removed (zero callers, so a clean honest widening). (Addresses S5 reviewer suggestions.)
