---
id: E6-S8-per-context-capture-profiles
epic: E6-CAP-capture-enrichment
status: ready-for-dev
area: capture
touches: [browser]
depends_on: [E6-S5-enrichment-optout-config, E6-S7-autocapture-opt-in]
api_impact: additive
---

# E6-S8-per-context-capture-profiles — Named contexts + `context()` scoped view

## Why

A consumer names contexts (e.g. `marketing` vs `app`) and toggles enrichment/autocapture/pageview per context — by config only (bar B) — while identity/session/transport stay shared so cross-context (pre-login) funnel stitching is preserved. This is the library's own design (no posthog-js analogue) and the natural last, deferrable slice.

## Scope

### In

- Config: `contexts: { <name>: { <profile> }, ... }` + `defaultContext: <name>`. A **capture profile** is a partial bundle of the ALREADY-SHIPPED R1 toggles only: `autocapture` (S7 boolean), the `pageleave` toggle (S2, via `enrichment.pageleave`), and the `enrichment` object (S5, incl. `country` from S6) — each optional per context, falling back to the top-level config default. **Do NOT introduce a `pageview` auto-vs-manual knob** — auto-pageview-on-history-change is explicitly OUT for R1 (S1/S2 Out; pageviews are manual/router-driven), so there is no auto/manual toggle to select per context. A profile SELECTS among existing toggles; it adds no new mechanism.
- A **scoped view**: `analytics.context('marketing')` returns a **narrower `ScopedAnalytics` type** exposing only the capture-time verbs a profile varies — `track`, `page`, `group` — that apply the named profile but **delegate identity/session/transport to the shared core** (same distinct id, cookie, session, transport). Identity/consent/lifecycle verbs (`identify`, `reset`, `optIn`/`optOut`, `flush`, `shutdown`) are NOT on the scoped view — they operate on the shared root only.
- `context()` is exposed via a **separate wrapper/factory surface, NOT added to the pinned `AnalyticsProvider` interface** — the frozen `keyof AnalyticsProvider` pin (`analytics-provider.test.ts:587-604`) stays at fifteen. **Where it lives (code-shape pin):** `createAnalytics` currently returns the `AnalyticsProvider` interface (`analytics-kit/src/create-analytics.ts:34-57`). Adding `context()` to that interface WOULD bump the 15-member pin — forbidden. Instead, widen the RETURN TYPE to a new exported type (e.g. `RootAnalytics<TX> = AnalyticsProvider<TX> & { context(name): ScopedAnalytics<TX> }`) and carry `context()` there; the underlying `AnalyticsProvider` interface (and its `keyof` pin) is untouched. Add a NEW, separate type-pin for `RootAnalytics`/`ScopedAnalytics` — do NOT extend or mutate the `analytics-provider.test.ts:587` pin.
- **`ScopedAnalytics` carries the SAME tightened `page()` signature E6-S1 lands.** `page` is one of the three scoped verbs; S1 tightens the facade `page(name?, props?)` to the taxonomy `page` shape (`ShapeOf`'s `page` field, `taxonomy.ts:42`). `ScopedAnalytics`'s `page` MUST use that identical taxonomy-typed signature — not a looser `NeutralProperties` one — so the scoped view type-checks a consumer's declared `page` props exactly as the root does. Same for `track`/`group` (they already carry the taxonomy generics on `AnalyticsProvider`).
- Thread `contexts`/`defaultContext` through config + the seam shape-pin (`packages/analytics-kit/src/create-analytics.test.ts:168-186`).

### Out

- Any change to the shared identity/session/transport core — those are shared by design; the scoped view only varies capture-time profile toggles.
- Adding `context` as a 16th facade verb — explicitly rejected (see Technical notes).
- Making the scoped view a full `AnalyticsProvider` — rejected; it is a narrower type.
- New enrichment/autocapture MECHANISMS — S8 only SELECTS among the toggles S2/S5/S7 already ship per named context.

## Acceptance criteria

- [ ] A consumer defines named contexts + a profile each by config only; `analytics.context('marketing').track(...)` applies the marketing profile (its enrichment/autocapture/pageview settings), and `analytics.context('app').track(...)` applies the app profile. (bar B)
- [ ] Switching context does NOT change identity/session/transport — same distinct id, same cookie, same session across contexts (verifiable: capture in two contexts, assert one shared distinct id + session → cross-context funnel stitching preserved).
- [ ] The scoped view exposes ONLY `track`/`page`/`group` (capture verbs) — not `identify`/`reset`/`optOut`/`flush`/`shutdown` (compile-time: `ScopedAnalytics` is narrower than `AnalyticsProvider`).
- [ ] `keyof AnalyticsProvider` stays the frozen fifteen (`analytics-provider.test.ts:587-604` unchanged); `context` is exposed on a separate widened return type (`RootAnalytics`) with its own NEW type-pin, and `ScopedAnalytics` has its own pin. (API-surface discipline)
- [ ] The scoped view's `page`/`track`/`group` carry the SAME taxonomy-typed signatures as the root (per E6-S1's tightened `page`) — a consumer's declared `page`/event props type-check through the scoped view identically.
- [ ] Seam `AnalyticsConfig` shape-pin (`packages/analytics-kit/src/create-analytics.test.ts:168-186`) updated for `contexts`/`defaultContext` and passing.
- [ ] All four gates green.

## Technical notes

- **DEFERRABLE / med-confidence slice — sequenced LAST.** Per architect, autocapture on/off and all enrichment toggles degrade cleanly to a single implicit context (S5/S7 plain config), so the whole per-context mechanism is cleanly deferrable and purely additive — nothing in S1–S7 depends on it. If E6 runs heavy, this can slip to a later additive slice without stranding anything (that safety comes from exposing `context()` as a wrapper, NOT a pinned verb). — architect (2026-07-08): §E6 Q2.
- **No posthog-js analogue — design from judgment.** posthog-js has one global config per instance; multiple named instances do NOT share persistence (so distinct id/cookie/session would diverge — breaks pre-login funnel stitching). One-instance-per-context is REJECTED. Design: single provider holding shared identity/session/transport + a map of named profiles; `context(name)` returns a lightweight scoped view delegating to the shared core. — architect (2026-07-07 + 2026-07-08): epic §E6.5, §E6 Q2.
- **`context()` is a factory/accessor, NOT a capture verb** — it returns a thing you operate on. Do NOT add it to the pinned `AnalyticsProvider` (that conflates "the capture surface" with "the mechanism producing capture surfaces", and spends the frozen pin's ceremony on a med-confidence shape). Expose it on a separate wrapper the root object carries alongside the fifteen verbs; add a NEW type-pin for it. — architect (2026-07-08): §E6 Q2 (option b).
- **Scoped view = narrower `ScopedAnalytics`, NOT a re-pinned `AnalyticsProvider`.** A scoped view must not expose `reset`/`optOut`/`identify`/`flush`/`shutdown` — those operate on the shared core, and it's a footgun to offer them on a per-context handle. Expose only the capture verbs a profile varies (`track`/`page`/`group`). This makes the shared-core-vs-scoped-view split legible in the types. — architect (2026-07-08): §E6 Q2.
- **Validate scoped-view ergonomics with the builder/architect during implementation** — this is the epic's lowest-confidence design (med). The requirement (shared core, config-only named contexts, narrower scoped type, pin untouched) is locked; the exact ergonomic shape of the wrapper is a builder/architect pin. — architect (2026-07-08): epic §E6.5 confidence-med caveat.
- Groups typing threads E3↔E6↔E2 — ensure `group()` typing flows through the scoped view too (it's one of the three capture verbs). Don't let `group` fall between identity and capture. — architect (2026-07-07): epic Notes.

## Shipped
- > Reviewer suggestion (2026-07-08): the seam-internal `ContextProfile`/`resolveEnrichmentProfile` is a hand-maintained structural subset of the config `CaptureProfile.enrichment` (deliberately decoupled so the seam doesn't import browser-flavored `EnrichmentConfig`) — add a one-line note that this subset must track `EnrichmentProfile` in lockstep if a future per-event toggle lands.
- > Reviewer suggestion (2026-07-08): `resolveEnrichmentProfile` emits all keys with explicit `undefined` when any `enrichment` is present; an all-`undefined` profile overrides `this.enrichment` wholesale but is observably identical (every toggle is opt-out-by-absence, read `!== false`) — a one-line comment noting the override is safe *because* toggles are opt-out-by-absence would help a future reader.

## Shipped

> Captured by `implement-epics` on 2026-07-08. THE last, deferrable, med-confidence slice — closes E6.

- **Architect ruling followed:** scoped view carries the resolved profile PER-EVENT (adapter-internal `NeutralEvent.enrichmentProfile`, peer of `isPageView` — no mutable active-context field, avoids the temporal-coupling race); per-event enrichment (page/device/referrer/utm/country/geoip) varies per context; **construction-time `autocapture`/`pageleave` resolve ONCE from `defaultContext`** (fallback top-level) — a documented, AC-consistent R1 boundary (per-non-default-context construction-time toggles = later additive slice).
- **Files changed (seam):** `neutral-event.ts` (+`EnrichmentProfile` + `NeutralEvent.enrichmentProfile?`, stripped at wire-map like `isPageView`), `create-analytics.ts` (+`CaptureProfile` + `AnalyticsConfig.contexts?`/`defaultContext?`, return → `RootAnalytics`), `analytics-provider.ts` (+`ScopedAnalytics<TX>` {track/page/group} + `RootAnalytics<TX> = AnalyticsProvider & {context()}`, `ScopedView` class delegating to shared impl, profile-aware track/page/group reusing the E3 allowlist + E4 consent-swap), `index.ts` (exports)
- **Files changed (browser):** `browser-adapter.ts` (`enrichContext`/`enrichAttribution` read `event.enrichmentProfile ?? this.enrichment`; `toWireEvent` reads profile `disableGeoip`), `create-analytics.ts` (resolve construction-time autocapture/pageleave from `defaultContext`; return `RootAnalytics`), `index.ts` (re-export)
- **New public API:** `AnalyticsConfig.contexts?`/`defaultContext?`; `createAnalytics` returns `RootAnalytics` (= `AnalyticsProvider` + `context(name): ScopedAnalytics`). **`keyof AnalyticsProvider` UNCHANGED at 15** — `context` on the separate `RootAnalytics` (own pin); `ScopedAnalytics` own pin = `track|page|group`. SPI `AnalyticsAdapter.capture` UNCHANGED (bar A).
- **Tests added:** seam +14 (RootAnalytics/ScopedAnalytics pins, `@ts-expect-error` narrowing, scoped==root taxonomy sigs, shared-distinct-id, profile-stamped/not-on-root, allowlist-gate + consent-swap on scoped, frozen-15-untouched, `not.toHaveProperty('context')`) → 153; browser +9 (config-only two-context enrichment diff, shared distinct-id+session through pipeline, defaultContext autocapture/pageleave seeding + fallback) → 581
- **Commit:** `E6-S8-per-context-capture-profiles — Named contexts + context() scoped view` on `core-cycle`
- **Reviewer notes:** 0 critical, 2 doc suggestions; E6-close-ready (capture layer coherent, both bars held)
- **Cross-story seams exposed:** per-context construction-time autocapture/pageleave (beyond `defaultContext`) = later additive slice (would need re-binding through `detachAutocaptureListeners`). `enrichmentProfile` is the adapter-internal per-event override channel — a future per-event toggle updates `ContextProfile`/`resolveEnrichmentProfile` + `EnrichmentProfile` in lockstep.
