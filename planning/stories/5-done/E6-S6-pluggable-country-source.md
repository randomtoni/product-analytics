---
id: E6-S6-pluggable-country-source
epic: E6-CAP-capture-enrichment
status: ready-for-dev
area: capture
touches: [browser, privacy]
depends_on: [E6-S5-enrichment-optout-config]
api_impact: additive
---

# E6-S6-pluggable-country-source — Pluggable country source + GeoIP disable

## Why

Country is NOT derived client-side by PostHog (it's server-side GeoIP). This exposes a neutral pluggable hook so a consumer/backend supplies country (e.g. from an edge header) without the library baking a vendor GeoIP, plus a switch to signal GeoIP-off.

## Scope

### In

- Add a `country` slot to the structured `enrichment` config (from E6-S5) — nest it INTO S5's coherent `enrichment` object (do NOT fork a divergent shape): `enrichment.country?: { countrySource?: ...; disableGeoip?: boolean }`, giving the full shape `{ page?, device?, referrer?, utm?, pageleave?, country? }`.
  - `countrySource` — a consumer-injected source of the country value (a value or a synchronous `() => string | undefined` provider; sync is enough for R1, e.g. reading an edge header the consumer has already surfaced).
  - a `disableGeoip` boolean — when true, signal the backend to skip its server-side GeoIP (de-brand posthog-js's `$geoip_disable` [WIRE] property; the neutral toggle sets the adapter-internal wire flag, the neutral surface never sees `$geoip_disable`).
- **When `countrySource` yields a value, deliver it via the FACADE `register({ country })` — NOT an adapter stamp.** Resolve `countrySource` once at init (in/near `resolveAdapter` / facade construction) and, if it yields a value, call the facade `register({ country })`. This routes the value through the E3 gate and stores it as a super-prop, which `mergeSuperProperties` merges onto every event as a default. Do NOT add `country` to `BrowserAdapterOptions` and do NOT stamp it inside `runCapturePipeline`. When the source yields nothing, do not register — no `country` key is emitted.
- **The injected country value is CONSUMER-SUPPLIED ⇒ allowlist-gated** — because it crosses the facade `register()` gate (`AnalyticsProviderImpl.allowed`, `analytics-provider.ts:104-111` / `:171-187`), an off-list `country` key fails loudly (throw / drop-and-error-log per `onViolation`) exactly like a consumer `track` prop. This is the E4-S7 / §E3.4 library-computed-trusted-vs-consumer-supplied-gated distinction, satisfied by reusing the existing gated `register()` path rather than duplicating the gate in the adapter.
- **`disableGeoip`** — this IS threaded into the adapter (`BrowserAdapterOptions` + `resolveAdapter` whitelist) as an adapter-internal `[WIRE]` flag; it is a library-set toggle, not a consumer VALUE, so it does not cross the allowlist. Only the `country` VALUE gate goes through `register()`.
- Update the seam `AnalyticsConfig` shape-pin (`packages/analytics-kit/src/create-analytics.test.ts:168-186`) to nest the `country` slot on `enrichment`. This re-touches the SAME pin line S5 added — S6 `depends_on` S5 for exactly this reason.

### Out

- Client-side GeoIP / IP-geolocation — explicitly NOT built (PostHog does GeoIP server-side; we do not bake a vendor GeoIP client-side). The library only accepts an injected value and/or signals GeoIP-off.
- An async country provider (Promise-returning) — R1 is synchronous; async is an additive later extension if a consumer needs it.
- The backend's actual GeoIP behavior — that's below the adapter seam (reference-backend concern).

## Acceptance criteria

- [ ] A consumer-injected `countrySource` value is delivered via the facade `register({ country })` and appears as a neutral `country` prop on captured events (merged as a super-prop default); when the source yields nothing, no `register` call and no `country` key is emitted. A per-call `track` prop `country` overrides the injected one for that event (super-prop-default precedence — `mergeSuperProperties`, `browser-adapter.ts:392`).
- [ ] `disableGeoip: true` sets the adapter-internal wire flag (de-branded `$geoip_disable`) without exposing `$geoip_disable` on the neutral surface. (bar A)
- [ ] The injected `country` value passes through the E3 allowlist because it crosses the facade `register()` gate — an off-list `country` key is rejected loudly per `onViolation` (throw / drop-and-error-log), identically to a consumer `track` prop. (E3 + §E3.4)
- [ ] `disableGeoip` is threaded through `resolveAdapter`/`BrowserAdapterOptions`; the seam `AnalyticsConfig` shape-pin includes the `enrichment.country` slot and passes; the `keyof AnalyticsProvider` pin stays fifteen. (bar B)
- [ ] All four gates green.

## Technical notes

- **Country is pluggable, never a baked client-side GeoIP** — locked. posthog-js derives country server-side (GeoIP); the client only carries `$geoip_disable` [WIRE] as a toggle. Expose a neutral `countrySource` hook + a `disableGeoip` switch; the injected value is consumer-supplied. — architect (2026-07-07): epic §E6.4 + Notes.
- **The gating distinction is the crux:** library-computed enrichment (S3/S4 page/device/utm) is TRUSTED (downstream of the allowlist); the injected country VALUE is CONSUMER-SUPPLIED, so it must be allowlist-gated. This is why S6 `touches: [browser, privacy]` while S3/S4 do not. — architect (2026-07-07): §E3.4 + §E6.4; the E4-S7 exemption distinction.
- **Enforcement seam — PINNED: route the injected country through the facade via `register({ country })`, NOT an adapter stamp.** `register()` is already the "consumer-supplied → gated once at the facade (`AnalyticsProviderImpl.allowed`, `analytics-provider.ts:171-187`) → trusted at merge" path; the country value crosses the identical E3 gate a `track` prop does, so an off-list `country` key fails loudly per `onViolation` with ZERO new gate and ZERO allowlist reference in the adapter (the adapter stays allowlist-agnostic). Resolve `enrichment.country.countrySource` at init and, if it yields a value, `register` it; do NOT add `country` to `BrowserAdapterOptions` or stamp it in `runCapturePipeline`. — architect (2026-07-08): §E6 country-gate seam. (This supersedes the earlier PM "confirm with architect during implementation" flag — the seam is now settled.)
  - **Caveat (pin in the impl):** `register()` is a once-at-init snapshot and super-props merge as defaults (per-call `country` wins). Correct for R1's synchronous edge-header provider (country-per-session is stable). A per-event-fresh country would need a different, gate-crossing seam — OUT OF SCOPE, do not build.
- Shape-pin discipline: nest the `country` slot on the `enrichment` object and extend the seam pin at `packages/analytics-kit/src/create-analytics.test.ts:168-186`. — established E4/E5 convention.
- `disableGeoip` → adapter-internal wire flag; `$geoip_disable` is [WIRE], never neutral surface. — posthog-source-guide / architect (2026-07-07).

## Shipped
- > Reviewer suggestion (2026-07-08, improvement-pass candidate): `resolveCountry` doesn't guard a throwing `countrySource` provider — a consumer sync provider (e.g. reading an edge header) that throws propagates out of `createAnalytics` and aborts client construction. Wrap the provider call in try/catch treating a throw as "yields nothing" (graceful degrade), OR document fail-loud as the deliberate contract in the pin comment.
- > Reviewer note (2026-07-08, cosmetic): `resolveAdapter` passes `disableGeoip: boolean | undefined`; the adapter normalizes `undefined → false` via `=== true` in the constructor (intentional, not the resolver).

## Shipped

> Captured by `implement-epics` on 2026-07-08.

- **Two mechanisms:** (1) country VALUE (consumer-supplied) → facade `register({country})` (E3-GATED — off-list rejected loudly per `onViolation`; adapter stays allowlist-agnostic; super-prop DEFAULT, per-call `track` overrides; yields-nothing→no register). (2) `disableGeoip` (library toggle, NOT gated) → adapter-internal `$geoip_disable` `[WIRE]` stamp, confined to browser wire layer.
- **Files changed (seam):** `create-analytics.ts` (+`CountryEnrichmentConfig {countrySource?, disableGeoip?}` NESTED into `EnrichmentConfig` → `{page?,device?,referrer?,utm?,pageleave?,country?}`) + shape-pin, `index.ts` (barrel-export)
- **Files changed (browser):** `create-analytics.ts` (`resolveCountry` value-or-sync-provider + `registerCountry` via facade `register` AFTER facade built; `disableGeoip` whitelist), `browser-adapter.ts` (`disableGeoip?` option → `toWireEvent`; NO `country`), `wire-mapper.ts` (`WireMapOptions` + stamp `$geoip_disable` in properties, undefined-props guard), `persistence-keys.ts` (+`GEOIP_DISABLE_WIRE_KEY='$geoip_disable'` — the SOLE `[WIRE]` const)
- **New public API:** `AnalyticsConfig.enrichment.country?: CountryEnrichmentConfig` (additive). Pin stays 15. `$geoip_disable` grep-EMPTY in seam.
- **Tests added:** browser +18 (country via register value+provider, super-prop-default+override, yields-nothing/absent→no-key, off-list rejected throw + drop-and-error-log, no-allowlist ungated, disableGeoip threads→`$geoip_disable` wire + bar-A NeutralEvent-clean + never-registers, undefined-props mint, merge composition) → 529; seam 139
- **Commit:** `E6-S6-pluggable-country-source — Pluggable country source + GeoIP disable` on `core-cycle`
- **Reviewer notes:** 0 critical, 2 suggestions (guard throwing countrySource; normalization note)
- **Cross-story seams exposed (S8):** `country` is a first-class `EnrichmentConfig` member — a per-context profile carries its own `country` config with no shape change. BUT: the country VALUE `register()` happens ONCE at global init (browser `create-analytics.ts`) not per-context — per-context country needs the resolution site to move (gate path unchanged). `disableGeoip` is resolved once at adapter construction into a private field → per-context GeoIP toggling would need the wire-stamp to read the active profile at map-time (stays below neutral surface). Country is a once-at-init snapshot (per-session stable — R1 caveat).
