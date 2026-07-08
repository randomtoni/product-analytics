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

- Add a `country` slot to the structured `enrichment` config (from E6-S5): an options object with
  - `countrySource` — a consumer-injected source of the country value (a value or a `() => string | undefined` provider — pick the simpler-that-works shape; a synchronous provider is enough for R1, e.g. reading an edge header the consumer has already surfaced).
  - a `disableGeoip` boolean — when true, signal the backend to skip its server-side GeoIP (de-brand posthog-js's `$geoip_disable` [WIRE] property; the neutral toggle sets the adapter-internal wire flag, the neutral surface never sees `$geoip_disable`).
- When `countrySource` yields a value, stamp it as a neutral `country` property on captured events.
- **The injected country value is CONSUMER-SUPPLIED ⇒ allowlist-gated** — unlike library-computed enrichment (page/device/referrer), the country VALUE comes from the consumer, so its key must be on the E3 allowlist; an off-list `country` key fails loudly (throw / drop-and-error-log per `onViolation`). This is the E4-S7 / §E3.4 library-computed-trusted-vs-consumer-supplied-gated distinction applied.
- Thread `country` through `resolveAdapter`'s whitelist and update the `AnalyticsConfig` shape-pin (`create-analytics.test.ts:167`) to include the `country` slot on `enrichment`.

### Out

- Client-side GeoIP / IP-geolocation — explicitly NOT built (PostHog does GeoIP server-side; we do not bake a vendor GeoIP client-side). The library only accepts an injected value and/or signals GeoIP-off.
- An async country provider (Promise-returning) — R1 is synchronous; async is an additive later extension if a consumer needs it.
- The backend's actual GeoIP behavior — that's below the adapter seam (reference-backend concern).

## Acceptance criteria

- [ ] A consumer-injected `countrySource` value is stamped as a neutral `country` prop on captured events; when the source yields nothing, no `country` key is emitted.
- [ ] `disableGeoip: true` sets the adapter-internal wire flag (de-branded `$geoip_disable`) without exposing `$geoip_disable` on the neutral surface. (bar A)
- [ ] The injected `country` value passes through the E3 allowlist as a consumer-supplied key — an off-list `country` key is rejected loudly per `onViolation` (throw / drop-and-error-log). (E3 + §E3.4)
- [ ] `enrichment.country` is threaded through `resolveAdapter` and the `AnalyticsConfig` shape-pin includes it and passes; the `keyof AnalyticsProvider` pin stays fifteen. (bar B)
- [ ] All four gates green.

## Technical notes

- **Country is pluggable, never a baked client-side GeoIP** — locked. posthog-js derives country server-side (GeoIP); the client only carries `$geoip_disable` [WIRE] as a toggle. Expose a neutral `countrySource` hook + a `disableGeoip` switch; the injected value is consumer-supplied. — architect (2026-07-07): epic §E6.4 + Notes.
- **The gating distinction is the crux:** library-computed enrichment (S3/S4 page/device/utm) is TRUSTED (downstream of the allowlist); the injected country VALUE is CONSUMER-SUPPLIED, so it must be allowlist-gated. This is why S6 `touches: [browser, privacy]` while S3/S4 do not. — architect (2026-07-07): §E3.4 + §E6.4; the E4-S7 exemption distinction.
  - **Implementation note:** the E3 allowlist gate lives at the FACADE (`AnalyticsProviderImpl.allowed`), which runs on consumer-supplied `track` props — but country is injected via config and stamped in the ADAPTER, below the facade gate. The builder must ensure the injected country value is still allowlist-checked (either re-run the allowlist check on the injected value in the adapter, or route the injection so it crosses the facade gate). Confirm the mechanism with the architect during implementation — the requirement (consumer-supplied ⇒ gated) is locked; the exact seam for enforcing it on a config-injected value needs a builder/architect pin. — PM flag (2026-07-08).
- Shape-pin discipline: extend `AnalyticsConfig` + the `create-analytics.test.ts:167` pin for the `country` slot on `enrichment`. — established E4/E5 convention.
- `disableGeoip` → adapter-internal wire flag; `$geoip_disable` is [WIRE], never neutral surface. — posthog-source-guide / architect (2026-07-07).

## Shipped
