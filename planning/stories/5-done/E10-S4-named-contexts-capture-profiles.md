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

- Config the harness with `contexts: { marketing: {...}, app: {...} }` and a `defaultContext`: `marketing` (autocapture on, per-event page enrichment on), `app` (autocapture off, manual/router-driven pageview posture). Config-only. **Each context MUST carry a distinct `enrichment` block** (e.g. `marketing: { enrichment: { page: true, utm: true } }` vs `app: { enrichment: { page: false, utm: false } }`) — the per-event stream difference is driven ENTIRELY by the `enrichment` block, NOT by `autocapture`: `resolveEnrichmentProfile` reads only `contexts[name].enrichment` (verified `AnalyticsProviderImpl`, `packages/analytics-kit/src/analytics-provider.ts` ~lines 127–141), and `autocapture` is a construction-time toggle resolved once from `defaultContext` at init, never varied per event. Contexts whose `enrichment` is absent both resolve to `undefined` and the stream would show NO difference — so give each a real, differing `enrichment`.
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
- [ ] **Bar-B diff invariant (enforced):** this story's changeset touches only `examples/**` — nothing under `packages/**`, verifiable by diff. If a required capability appears missing, it is a **bar-B failure** — file it as a bug against the owning epic (E2–E9) per the epic Notes; do NOT patch `packages/*` in E10.

## Technical notes

- **Contexts are config-selected profiles (E6-S8).** `AnalyticsConfig.contexts: Record<string, CaptureProfile>` + `defaultContext` (`packages/analytics-kit/src/create-analytics.ts`). `RootAnalytics.context(name)` returns a narrower `ScopedAnalytics<TX>` — three verbs (`track`/`page`/`group`), taxonomy-typed identically to the root (`packages/analytics-kit/src/analytics-provider.ts`). A `CaptureProfile` is `{ autocapture?, enrichment? }` — a partial bundle of already-shipped toggles; it adds no new mechanism.
- **Shared core is the point.** — architect (2026-07-08): the scoped view holds no identity/session/transport of its own; every call delegates to the shared impl (same distinct id, same session). Assert this on the recording adapter: capture from both contexts → both events carry the same `distinctId`. This is the cross-context funnel-stitching proof at the seam.
- **What the profile varies live.** `context(name)` flattens the named profile into an `EnrichmentProfile` (`page`/`device`/`referrer`/`utm`/`disableGeoip`) that rides the minted event via `enrichmentProfile` (`AnalyticsProviderImpl.resolveEnrichmentProfile` / `trackWithProfile`). Assert the resolved profile differs per context. Construction-time toggles (`autocapture`/`pageleave`) resolve once from the `defaultContext` at init — per-event enrichment is what varies live per context.
- **Runs against the mock (shape A).** All of this is facade behavior — it runs against the recording adapter injected through the seam factory. No `BrowserAdapter`.

## Shipped

## Shipped

> Captured by `implement-epics` on 2026-07-09. Exercises E6-S8 per-context capture profiles at the neutral seam (bar-B proof).

- **Files added (examples ONLY — bar B):** `named-contexts-capture-profiles.test.ts` (7 tests) — NO source change; the E6-S8 seam accepts `config.contexts`/`defaultContext` config-only + the recorder already stores the full `NeutralEvent` (so `enrichmentProfile` is inspectable).
- **New public API:** none — example-only. ZERO `packages/**` edits (bar B).
- **Shared-core / funnel-stitching (crux):** `context('marketing')` + `context('app')` scoped views BOTH stamp the SAME distinct id (`new Set(distinctIds).size === 1`) — the scoped view holds no identity/session (delegates to the shared impl via `currentDistinctId`→`liveAdapter.getDistinctId`). **Strongest evidence:** the post-`identify` variant — identity is a ROOT verb (absent from `ScopedAnalytics`), so both contexts inherit `reviewer-42` after a root identify (stitch survives an identity transition).
- **Per-context enrichment (the enrichment-drives-it pin):** each context carries a DISTINCT `enrichment` block (`marketing:{page:true,utm:true}` vs `app:{page:false,utm:false}`); the resolved `enrichmentProfile` on the minted `NeutralEvent` DIFFERS per context (`.toEqual`-expected + `.not.toEqual`-each-other, on `track` AND `page`). **Enrichment-driven, NOT autocapture** — `resolveEnrichmentProfile` reads ONLY `contexts[name].enrichment`; the `bare`-context edge (absent `enrichment`) → `undefined` actively proves autocapture doesn't drive the profile. Regression pin: a ROOT `track` → `enrichmentProfile === undefined` (scoped override never bleeds onto root).
- **Tests added:** fernly +7 (config-only construct, same-distinct-id both-contexts, same-id-post-identify, enrichmentProfile-differs on track + page, root-undefined regression, bare-context→undefined edge) → 49; turbo typecheck+test green; bar-B holds
- **Commit:** `E10-S4-named-contexts-capture-profiles — Named contexts + capture profiles sharing identity/session/transport` on `core-cycle`
- **Reviewer notes:** ship-ready — 0 critical, 0 suggestions
- **Cross-story seams exposed (S5):** allowlist loud-failure is a DIFFERENT slice — supplies an explicit `allowlist` config + asserts an off-list key (raw-PII e.g. `ssn`) triggers the loud failure. The loud path routes through the facade `enforceAllowlist` gate; `register({ssn})` (`NeutralProperties`) hits it at RUNTIME (an off-list key on a taxonomy-typed props bag is a COMPILE error first — route via `register`). Config-only, independent of context wiring.
