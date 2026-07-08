---
id: E4-S2-persistence-store-modes
epic: E4-ID-identity-persistence
status: ready-for-dev
area: identify
touches: [browser]
depends_on: [E4-S1-browser-substrate-spike]
api_impact: additive
---

# E4-S2-persistence-store-modes — Persistence store + config-selectable modes behind the SPI

## Why

Every identity / session / super-prop value E4 mints must survive reloads through a config-selectable store; without the persistence substrate none of S3–S9 can persist anything. This ports posthog-js's persistence layer, de-branded, behind the shipped `getPersistedProperty` / `setPersistedProperty` SPI.

## Scope

### In

- Port `posthog-persistence.ts` de-branded into the browser adapter, backing the shipped SPI `getPersistedProperty` / `setPersistedProperty`.
- Three config-selectable modes: `cookie` | `localStorage+cookie` | `memory`, defaulting to `localStorage+cookie`; the cookie half carries ONLY the small identity/session keys, localStorage holds the bulk; `memory` holds nothing durably.
- Add `persistence?: 'cookie' | 'localStorage+cookie' | 'memory'` to `AnalyticsConfig` (additive, optional, default `'localStorage+cookie'`).
- `register` / `register_once` / `unregister` STORAGE mechanics (the storage half only; the facade API + gating is S7).
- Save-debounce + unload flush.
- Neutral storage-key naming — no `ph_` / `_posthog` / `$` prefixes; keys named by role.
- Low-level storage backends (cookie get/set, localStorage get/set, memory) usable by S3's dedicated consent read WITHOUT constructing the full property store — avoids the consent-through-gated-persistence circularity.

### Out

- Cross-subdomain cookie domain + public-suffix probe — **S4**.
- The consent-first write gate — **S3** (S2 writes unconditionally; S3 adds the suppression).
- Facade `register` / `registerOnce` / `unregister` methods + allowlist gating + merge-into-events — **S7**.
- Anon / device id values, session values — **S5 / S8** (S2 is the store, not the minters).

## Acceptance criteria

- [ ] `getPersistedProperty` / `setPersistedProperty` round-trip a value in all three modes; `memory` mode persists nothing across a fresh store instance.
- [ ] Default mode is `localStorage+cookie`; the cookie half carries only identity/session keys, localStorage the bulk (verified by inspecting which backend a bulk key lands in).
- [ ] The `persistence` config field selects the mode; omitting it yields `localStorage+cookie`.
- [ ] Storage keys contain no `ph_` / `_posthog` / `$` / vendor tokens; `grep -ri posthog packages/browser/src` clean.
- [ ] `register` / `register_once` / `unregister` storage semantics: register overwrites, register_once keeps the first value, unregister removes.
- [ ] Save-debounce coalesces writes; an unload flush persists pending writes.
- [ ] jsdom tests only, no real backend; `pnpm --filter @analytics-kit/browser` gates green.

## Technical notes

- **Default is `localStorage+cookie`, not pure cookie (— architect 2026-07-07, refiner-verified `posthog-core.ts:235`):** PostHog abandoned the pure-cookie default (~4 KB cap); the BRIEF's "cookie default" is satisfied by cookie-backed identity/session keys while the bulk sits in localStorage. PM-confirmed default choice, not a technical unknown.
- **De-brand the keys (— architect 2026-07-07):** `$sesid`, `$device_id`, `$anon_distinct_id`, `distinct_id`, `ph_`-prefixed names are all [WIRE] — normalize to neutral role-named keys inside the adapter. No `$`-prefixed names on any neutral surface.
- **Separate low-level backends for consent (Q5a):** expose the raw storage primitives so S3's consent read can run a dedicated side-effect-free read BEFORE the property store (and its domain probe) is constructed — reading consent through the persistence you're gating is circular.
- **Config field is additive (bar A):** `persistence?` on `AnalyticsConfig` is optional with a default — provider-swap stays zero-consumer-change; a non-browser target ignores it.
- reference: `posthog-js/packages/browser/src/storage.ts` + `posthog-persistence.ts`; de-brand.
- > Reviewer suggestion (2026-07-08): storage keys `distinct_id`/`anonymous_distinct_id` keep "distinct_id" (PostHog/Mixpanel-origin) vocabulary. NOTE (orchestrator): the library already committed to `distinctId` as its OWN neutral term across the whole seam (E2 — NeutralEvent.distinctId, SPI getDistinctId, identify(distinctId,…)); the storage key matches that shipped public vocabulary, and `grep posthog` is clean. Changing storage to `user_id` would DESYNC from the public API. Skip-with-reason (consistent with the library's own neutral term).
- > Reviewer suggestion (2026-07-08, forward-fix for S3): `BrowserAdapter` ctor constructs `createMemoryBackend()` inline and discards the reference. S3's memory-mode consent read needs the SAME instance — hoist it to a `private readonly` field. Clean additive fix, not an S2 blocker.
- > Reviewer suggestion (2026-07-08, improvement-pass candidate): `PersistenceStore` adds permanent `beforeunload`/`pagehide` window listeners with no teardown (faithful to posthog, but they accumulate when the library is instantiated repeatedly — tests already create dozens). Consider a `dispose()`/teardown or listener dedupe.
- > Reviewer suggestion (2026-07-08): the mode union is duplicated — seam `AnalyticsConfig.persistence` inline literal vs browser `PersistenceMode`. Inherent (seam can't import the browser package without layering inversion); the seam shape-pin guards seam-side drift. Noting two sources of truth; layering-inherent, no clean fix.

## Shipped

> Captured by `implement-epics` on 2026-07-08.

- **Files added (browser):** `persistence-keys.ts` (neutral role-named keys + `COOKIE_MIRRORED_KEYS` + `storeName`), `storage-backends.ts` (cookie/localStorage/memory backends + `buildPropsBackend`), `persistence-store.ts` (store + register/registerOnce/unregister + debounce + unload flush) + tests
- **Files changed:** `browser-adapter.ts` (ctor `{key,persistence?}` + SPI backing), `browser/create-analytics.ts` (thread mode), `analytics-kit/create-analytics.ts` (+`AnalyticsConfig.persistence?`) + shape-pin
- **New public API:** `AnalyticsConfig.persistence?: 'cookie' | 'localStorage+cookie' | 'memory'` (additive, default `localStorage+cookie`)
- **Tests added:** browser 28 new (storage-backends 17, persistence-store 11) + adapter/entry mode tests → 60 total; seam 99 (extended shape-pin)
- **Commit:** `E4-S2-persistence-store-modes — Persistence store + config-selectable modes behind the SPI` on `core-cycle`
- **Reviewer notes:** 0 critical, 4 suggestions → see Technical notes (S1's de-brand held; the one flagged vocab is consistent with the library's own `distinctId`)
- **Cross-story seams exposed:** `PersistenceStore` API (`getProperty`/`register`/`registerOnce(props,defaultValue?)`/`unregister`/`flush`/`clear`) backs the SPI. Mode plumbing: `AnalyticsConfig.persistence?` → `resolveAdapter` → `BrowserAdapterOptions` → `buildPropsBackend(mode, memoryBackend)`. **S3 consent-read seam:** raw `cookieBackend`/`localStorageBackend`/`createMemoryBackend()` (side-effect-free single-entry get/parse/set/remove) — read a dedicated consent entry BEFORE constructing the store; in memory mode share the adapter's memory instance (hoist it — see suggestion). **Neutral keys** in `persistence-keys.ts` (`DISTINCT_ID_KEY`/`DEVICE_ID_KEY`/`SESSION_ID_KEY`/`ANONYMOUS_DISTINCT_ID_KEY`/`IDENTITY_STATE_KEY`) — S5/S8 import, don't re-declare (on-disk contract).
## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->
