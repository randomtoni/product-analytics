---
id: E10-S4-named-contexts-capture-profiles
epic: E10-CORE-example-consumer
status: ready-for-dev
area: core
touches: [example, capture, browser]
depends_on: [E10-S1-fernly-scaffold-recording-adapter, E10-S2-fernly-taxonomy-identity-mapping]
api_impact: additive
---

# E10-S4-named-contexts-capture-profiles — Named contexts + capture profiles sharing identity/session/transport

## Why

Exercises E6's per-context capture profiles at the seam: the consumer defines named contexts (`marketing` vs `app`) each with its own capture profile, and the library applies the profile while the contexts share one identity/session/transport — so cross-context funnel stitching survives. This proves a consumer configures distinct capture postures per surface by config alone.

## Scope

### In

- Config the harness with `contexts: { marketing: {...}, app: {...} }` and a `defaultContext`: `marketing` (autocapture on, per-event page enrichment on), `app` (autocapture off, manual/router-driven pageview posture). Config-only.
- Use `analytics.context('marketing')` and `analytics.context('app')` scoped views to `track`/`page` from each context, and assert on the recorded stream that BOTH contexts stamp the **same distinct id** (shared identity/session/transport) while carrying their respective per-event enrichment profile.
- A runnable vitest test: capture from each context, assert one shared distinct id across both, and assert the resolved enrichment profile differs per context (the `enrichmentProfile` rides the minted event).

### Out

- The cross-subdomain merge/reset (S3), allowlist (S5), node/query/react (S6/S7/S8).
- Any DOM autocapture listener behavior (that's E6's own tests) — here we assert the profile is APPLIED/selected via config, on the neutral stream.
- Any `packages/*` edit.

## Acceptance criteria

- [ ] `contexts` + `defaultContext` supplied via config only; harness constructs with zero `packages/*` change.
- [ ] `context('marketing')` and `context('app')` scoped views both stamp the SAME distinct id — asserted on the recorded stream (shared identity/session/transport).
- [ ] The per-context enrichment profile differs between the two contexts and rides the minted event — asserted on the stream (`NeutralEvent.enrichmentProfile`).
- [ ] `turbo run typecheck` + `turbo run test` pass for `examples/fernly`.

## Technical notes

- **Contexts are config-selected profiles (E6-S8).** `AnalyticsConfig.contexts: Record<string, CaptureProfile>` + `defaultContext` (`packages/analytics-kit/src/create-analytics.ts`). `RootAnalytics.context(name)` returns a narrower `ScopedAnalytics<TX>` — three verbs (`track`/`page`/`group`), taxonomy-typed identically to the root (`packages/analytics-kit/src/analytics-provider.ts`). A `CaptureProfile` is `{ autocapture?, enrichment? }` — a partial bundle of already-shipped toggles; it adds no new mechanism.
- **Shared core is the point.** — architect (2026-07-08): the scoped view holds no identity/session/transport of its own; every call delegates to the shared impl (same distinct id, same session). Assert this on the recording adapter: capture from both contexts → both events carry the same `distinctId`. This is the cross-context funnel-stitching proof at the seam.
- **What the profile varies live.** `context(name)` flattens the named profile into an `EnrichmentProfile` (`page`/`device`/`referrer`/`utm`/`disableGeoip`) that rides the minted event via `enrichmentProfile` (`AnalyticsProviderImpl.resolveEnrichmentProfile` / `trackWithProfile`). Assert the resolved profile differs per context. Construction-time toggles (`autocapture`/`pageleave`) resolve once from the `defaultContext` at init — per-event enrichment is what varies live per context.
- **Runs against the mock (shape A).** All of this is facade behavior — it runs against the recording adapter injected through the seam factory. No `BrowserAdapter`.

## Shipped
