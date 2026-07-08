---
id: E6-S5-enrichment-optout-config
epic: E6-CAP-capture-enrichment
status: ready-for-dev
area: capture
touches: [browser]
depends_on: [E6-S2-pageleave-unload, E6-S3-context-enrichment-port, E6-S4-utm-campaign-session-entry]
api_impact: additive
---

# E6-S5-enrichment-optout-config — Structured `enrichment` opt-out config

## Why

The BRIEF requires each enrichment individually opt-out-able **by config only** (bar B). This lands one structured `enrichment` config object — a boolean/options per module — replacing posthog-js's scatter of flat booleans, and wires it through to the adapter so each of S2/S3/S4's modules honors its toggle.

## Scope

### In

- Add a single structured `enrichment` field to `AnalyticsConfig` (seam) — one boolean (or options object) per enrichment module:
  - `page`, `device`, `referrer`, `utm`, `pageleave` — each `boolean` (default on).
  - `country` — an options object (the S6 slot; declare the field here as `unknown`/a placeholder shape that S6 fills, or leave `country` out and let S6 add it — pick the additive path; see Technical notes).
- Thread `enrichment` through the browser `create-analytics.ts` `resolveAdapter` whitelist into `BrowserAdapterOptions`, and gate each enrichment module (S3 page/device/referrer, S4 utm, S2 pageleave) on its toggle. Default = all on (opt-OUT semantics).
- **Extend the two frozen type-pins in lockstep** — this is a config + (potentially) no facade change:
  - The `AnalyticsConfig` shape-pin (`create-analytics.test.ts:167`, the exact `toEqualTypeOf` literal) MUST gain the `enrichment` field, or the pin fails. Update it deliberately.
  - No facade verb changes ⇒ the `keyof AnalyticsProvider` pin (`analytics-provider.test.ts:587`) stays at fifteen.

### Out

- The `country` source implementation + GeoIP switch — E6-S6 (this story only reserves/shapes the `country` slot in the config object).
- Per-context profiles (different enrichment per context) — E6-S8. This story is the single global `enrichment` object; S8 layers per-context overrides on top.
- Any new enrichment module — this only wires opt-outs for S2/S3/S4's existing modules.

## Acceptance criteria

- [ ] `AnalyticsConfig.enrichment` exists as a structured object with a per-module toggle; each of page/device/referrer/utm/pageleave is individually disable-able. Setting one `false` disables ONLY that module; the rest stay on. (bar B)
- [ ] Default (no `enrichment` key, or an omitted module) = enrichment on (opt-out, not opt-in) — matches posthog-js's default-on `save_campaign_params`/`save_referrer`.
- [ ] The `enrichment` config is threaded through `resolveAdapter`'s explicit whitelist (no config field silently dropped).
- [ ] The `AnalyticsConfig` shape-pin (`create-analytics.test.ts:167`) is updated to include `enrichment` and passes; the `keyof AnalyticsProvider` pin stays fifteen. (bar B / API-surface discipline)
- [ ] All four gates green.

## Technical notes

- **Structured object, not flat booleans** — locked. posthog-js scatters `save_campaign_params`/`save_referrer`/`property_denylist`/`respect_dnt`/etc. (`posthog-core.ts:239-279`); a single `enrichment: { page, device, referrer, utm, pageleave, country }` maps 1:1 to "each individually opt-out-able" and is more discoverable. — architect (2026-07-07): epic §E6.4.
- **Shape-pin discipline (load-bearing):** the `AnalyticsConfig` literal in `create-analytics.test.ts:167` is an exact `toEqualTypeOf` pin — every new config field extends it in lockstep or the test fails. Add `enrichment?: {...}` to BOTH the type and the pin. This is the same discipline E4/E5 config fields followed. — established E4/E5 convention.
- **`country` slot — pick the additive path:** either declare `country` in the `enrichment` shape now as a forward-compatible options type that S6 fills, OR omit it and let S6 add it (S6 will itself touch the shape-pin). Prefer omitting here so S6 owns the whole country shape in one place and there's one pin bump for country, not two. Coordinate: S6 `depends_on` S5, so S6 sees this object and extends it.
- `resolveAdapter` uses an explicit field whitelist (`browser/create-analytics.ts:17-35`) — add `enrichment` there or it never reaches the adapter. — established E5 convention.
- The `pageleave` toggle default follows `'if_capture_pageview'` semantics from E6-S2 — wire E6-S2's plain adapter boolean to read from `enrichment.pageleave` here. — architect (2026-07-07): epic §E6.3.
- Note (privacy, `touches` — NOT this story's scope but adjacent): posthog-js's masking/denylist hooks (`property_denylist`/`sanitize_properties`/`mask_personal_data_properties`) are the INVERSE of E3's allowlist and are retained as neutral privacy hooks — but they are a separate privacy concern, not an `enrichment` toggle. Do NOT fold them into this object. — architect (2026-07-07): epic §E3.3.

## Shipped
