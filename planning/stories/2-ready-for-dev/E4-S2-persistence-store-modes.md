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

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->
