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

- Add a single structured `enrichment` field to `AnalyticsConfig` — which lives in the **seam** package (`packages/analytics-kit/src/create-analytics.ts:10-28`), NOT the browser one. One boolean per enrichment module:
  - `page`, `device`, `referrer`, `utm`, `pageleave` — each `boolean` (default on).
  - **`country` — OMITTED here.** E6-S6 owns the whole `country` slot (an options object) and extends this same `enrichment` shape + its pin. See Technical notes for the additive-path rationale.
  - Shape: `enrichment?: { page?: boolean; device?: boolean; referrer?: boolean; utm?: boolean; pageleave?: boolean }` — all fields optional (absent ⇒ on). This is the ONE coherent `enrichment` object S6 nests `country` into and S8 reads per-context; do NOT let S6/S8 fork a divergent shape.
- Thread `enrichment` into `BrowserAdapterOptions` (`browser-adapter.ts:65-99`) and through the browser `create-analytics.ts` `resolveAdapter` explicit whitelist (`browser/create-analytics.ts:17-35` — add `enrichment: config.enrichment` to the `new BrowserAdapter({...})` field list or it is silently dropped), and gate each enrichment module (S3 page/device/referrer, S4 utm, S2 pageleave) on its toggle. Default = all on (opt-OUT semantics).
- **Extend the frozen `AnalyticsConfig` type-pin in lockstep** — this is a config change, no facade change:
  - The `AnalyticsConfig` shape-pin is in the **seam** package: `packages/analytics-kit/src/create-analytics.test.ts` — the `expectTypeOf<AnalyticsConfig>().toEqualTypeOf<{...}>()` literal at **lines 168-186** (test declared at `:167`). It MUST gain the `enrichment?: {...}` field, or the pin fails. Add it to BOTH the `AnalyticsConfig` type (`create-analytics.ts:10-28`) and this pin literal in one commit.
  - No facade verb changes ⇒ the `keyof AnalyticsProvider` pin (`analytics-provider.test.ts:587-604`) stays at fifteen.

### Out

- The `country` source implementation + GeoIP switch — E6-S6 (this story only reserves/shapes the `country` slot in the config object).
- Per-context profiles (different enrichment per context) — E6-S8. This story is the single global `enrichment` object; S8 layers per-context overrides on top.
- Any new enrichment module — this only wires opt-outs for S2/S3/S4's existing modules.

## Acceptance criteria

- [ ] `AnalyticsConfig.enrichment` exists as a structured object with a per-module toggle; each of page/device/referrer/utm/pageleave is individually disable-able. Setting one `false` disables ONLY that module; the rest stay on. (bar B)
- [ ] Default (no `enrichment` key, or an omitted module) = enrichment on (opt-out, not opt-in) — matches posthog-js's default-on `save_campaign_params`/`save_referrer`.
- [ ] The `enrichment` config is threaded through `resolveAdapter`'s explicit whitelist (no config field silently dropped).
- [ ] The seam `AnalyticsConfig` shape-pin (`packages/analytics-kit/src/create-analytics.test.ts:168-186`) is updated to include `enrichment` and passes; the `keyof AnalyticsProvider` pin stays fifteen. (bar B / API-surface discipline)
- [ ] All four gates green.

## Technical notes

- **Structured object, not flat booleans** — locked. posthog-js scatters `save_campaign_params`/`save_referrer`/`property_denylist`/`respect_dnt`/etc. (`posthog-core.ts:239-279`); a single `enrichment: { page, device, referrer, utm, pageleave, country }` maps 1:1 to "each individually opt-out-able" and is more discoverable. — architect (2026-07-07): epic §E6.4.
- **Shape-pin discipline (load-bearing):** the `AnalyticsConfig` literal at `packages/analytics-kit/src/create-analytics.test.ts:168-186` is an exact `toEqualTypeOf` pin — every new config field extends it in lockstep or the test fails. Add `enrichment?: {...}` to BOTH the type (`create-analytics.ts:10-28`) and the pin literal. This is the same discipline E4/E5 config fields followed. — established E4/E5 convention.
- **`country` slot — additive path chosen: OMIT here, S6 adds it.** Do NOT declare a placeholder `country` in the `enrichment` shape now. E6-S6 `depends_on` S5, sees this `enrichment` object, and nests the whole `country` options slot into it in one place — so there is ONE pin bump for country, not two, and no throwaway placeholder type. S5 ships the 5-boolean shape; S6 extends it to `{ ...the 5 booleans, country?: {...} }`. — story-refiner (2026-07-08), per epic §E6.4 additive posture.
- `resolveAdapter` uses an explicit field whitelist inside its `new BrowserAdapter({...})` call (`browser/create-analytics.ts:17-35`) — add `enrichment: config.enrichment` there AND declare `enrichment` on `BrowserAdapterOptions` (`browser-adapter.ts:65-99`) or it never reaches the adapter. — established E5 convention.
- The `pageleave` toggle default follows `'if_capture_pageview'` semantics from E6-S2 — wire E6-S2's plain adapter boolean to read from `enrichment.pageleave` here. — architect (2026-07-07): epic §E6.3.
- Note (privacy, `touches` — NOT this story's scope but adjacent): posthog-js's masking/denylist hooks (`property_denylist`/`sanitize_properties`/`mask_personal_data_properties`) are the INVERSE of E3's allowlist and are retained as neutral privacy hooks — but they are a separate privacy concern, not an `enrichment` toggle. Do NOT fold them into this object. — architect (2026-07-07): epic §E3.3.

## Shipped
