---
id: E6-CAP-capture-enrichment
status: done
area: capture
touches: [browser, privacy]
api_impact: additive
blocked_by: [E5-CAP-transport]
updated: 2026-07-08
---

# E6-CAP-capture-enrichment — Browser capture & enrichment

## Why

This is the consumer-facing top of the `capture` cycle: the `track` / `page` / `pageleave` primitives plus the auto-enrichment (page/UTM/device context) that makes captured events useful, all riding the E5 transport layer. It also lands two things with no clean PostHog analogue — a structured per-enrichment opt-out surface and **per-context capture profiles** — so a consumer names its contexts and toggles enrichment/autocapture entirely by config (bar B). Enrichment and autocapture are minimal ports/de-brands of posthog-js (BRIEF §3, §5), with `$`-prefixed wire names normalized away. Informed by `research/ARCHITECT-RELEASE1.md` §E6.

## Success criteria

- `track` / `page` / `pageleave` produce neutral events; **no `$`-prefixed name appears on the neutral surface** (the adapter maps neutral keys to the wire).
- Each enrichment (page, UTM, device/browser, referrer, pageleave, country) is individually disable-able via the structured `enrichment` config object — **config only** (bar B).
- The country source is pluggable (consumer-injected, e.g. an edge header) and GeoIP is disable-able; the injected country **value** passes the E3 allowlist (consumer-supplied ⇒ gated).
- A consumer defines named contexts + capture profiles by **config only** (bar B); switching the active context applies its profile while identity/session/transport stay **shared** — same distinct id, cookie, and session, so cross-context (pre-login) funnel stitching is preserved.
- Autocapture defaults **OFF**, opts in per context, and does **not** phone home for gating (PostHog's remote-config coupling removed).
- Enrichment/capture logic sits above the adapter so wire-name mapping is the adapter's job — a provider swap is one adapter, zero consumer change (bar A).

## Stories

All eight shipped to `5-done/`. `track`/`page`/`group` verbs already existed (E2); **no facade verb was added this epic — the frozen `keyof AnalyticsProvider` pin held at fifteen.** `pageleave` is adapter-internal, `context()` is a separate `RootAnalytics` wrapper — neither a verb. A neutral `NeutralEvent.isPageView` discriminator (S2) makes named router-driven pageviews recognizable; `$pageview`/`$pageleave`/`$autocapture`/`$geoip_disable` are all `[WIRE]`-confined to the browser adapter.

- **[E6-S1](../stories/5-done/E6-S1-pageview-state-page-typing.md)** *(done — `b002d52`)* — adapter-internal pageview record `{timestamp, pageViewId, pathname}` (reset on rotation via `lastSeenSessionId`) + taxonomy-typed `page()`.
- **[E6-S2](../stories/5-done/E6-S2-pageleave-unload.md)** *(done — `b3c3979`)* — neutral `pageleave` minted in `unload()` riding the E5 beacon (seconds duration); + the **`isPageView` neutral discriminator** so named `page('/x')` is recognized; `wireEventName()` maps `$pageview`/`$pageleave`.
- **[E6-S3](../stories/5-done/E6-S3-context-enrichment-port.md)** *(done — `e2978c4`)* — fresh-per-event page/device/browser/OS/referrer/timezone/lib context to neutral keys; a **pure DOM-free `parseUserAgent`** separate from bot-detection.
- **[E6-S4](../stories/5-done/E6-S4-utm-campaign-session-entry.md)** *(done — `2bef544`)* — UTM/campaign + click-id (per-event) + `session_entry_*` (per-session) + `initial_*` (set-once); consolidated rotation into `classifySessionTransition`.
- **[E6-S5](../stories/5-done/E6-S5-enrichment-optout-config.md)** *(done — `6f7cb9b`)* — one structured `enrichment` config object (page/device/referrer/utm/pageleave toggles), opt-out semantics.
- **[E6-S6](../stories/5-done/E6-S6-pluggable-country-source.md)** *(done — `122cba4`)* — consumer-injected `countrySource` (→ facade `register`, E3-gated) + `disableGeoip` (→ `$geoip_disable` `[WIRE]`).
- **[E6-S7](../stories/5-done/E6-S7-autocapture-opt-in.md)** *(done — `ffdf8a3`)* — **the large port.** Minimal DOM autocapture (click/change/submit → element metadata), default OFF, remote-config phone-home REMOVED, sensitive-value scrub kept.
- **[E6-S8](../stories/5-done/E6-S8-per-context-capture-profiles.md)** *(done — `7c8ce83`)* — named `contexts` + `defaultContext`; `context(name)` → narrower `ScopedAnalytics` (capture verbs only) sharing identity/session/transport, per-event profile carried on `NeutralEvent.enrichmentProfile`. **No posthog-js analogue.**

Dependency graph (built topo order S1,S3 → S2,S4 → S5 → S6,S7 → S8):

```
E6-S1 ─▶ E6-S2 ─┐
E6-S3 ─▶ E6-S4 ─┼─▶ E6-S5 ─▶ E6-S6
E6-S3 ─────────▶ E6-S7 ──────┐
                 E6-S5 ──────┴─▶ E6-S8
```

Roots (no deps): **E6-S1**, **E6-S3**. E6-S5 fans in S2+S3+S4; E6-S8 fans in S5+S7 and lands last.

## Out of scope

- Batching, retry, compression, transport selection, ingest host config, dedupe id — all E5-CAP-transport (E6 rides that layer).
- Anonymous id, cookie/memory persistence, session id assignment/expiry, `identify` merge, `reset` — E4-ID-identity-persistence (E6 reads the session id; it does not mint it).
- Rageclick / dead-click / copy-autocapture and any remote-config-driven autocapture — not this release; the minimal autocapture port extends additively in a later cycle.
- Session replay, feature flags — typed extension points only (E2), not implemented.

## Notes

- The *capability* (which context to add, the opt-outs) is neutral; the property **names** (`$current_url`, `$session_entry_*`, `$prev_pageview_*`, `$geoip_disable`) are **[WIRE]** and normalized by the adapter — no `$`-prefixed name on the neutral surface. — architect (2026-07-07): §E6 neutral-seam note.
- Enrichment keys the library **computes** are trusted (added downstream of the E3 facade allowlist, and each independently opt-out-able here); only consumer-**supplied** values — event props, traits, and the injected `countrySource` — are gated by the allowlist. — architect (2026-07-07): §E3.4 + §E6.4.
- Use a **single structured `enrichment` object** (a boolean/options per module) rather than PostHog's flat scatter of booleans — maps 1:1 to "each individually opt-out-able." — architect (2026-07-07): §E6.4.
- **Per-context capture profiles have no posthog-js analogue** — do not port. Design: one provider holding shared identity/session/transport + a map of named profiles; `analytics.context('marketing')` returns a lightweight scoped view that applies the profile but delegates identity/session/transport to the shared core, preserving cross-context funnel stitching. One-instance-per-context is rejected (PostHog instances don't share persistence). Confidence med — validate scoped-view ergonomics with the builder. — architect (2026-07-07): §E6.5.
- Autocapture defaults **OFF** per context (BRIEF), reversing PostHog's default-on + remote-config gating; the port must **remove** the remote-config coupling or a de-branded autocapture will silently phone home for gating. Minimal port (clicks/changes/submits + element metadata); skip rageclick/dead-click/copy. — architect (2026-07-07): §E6.6 + §E-cross.
- `pageview`/`pageleave` use neutral names with PostHog's toggle semantics (`capture_pageview`/`capture_pageleave` defaults). — architect (2026-07-07): §E6.3.
- Masking/denylist privacy hooks (PostHog's `property_denylist` / `sanitize_properties` / `mask_personal_data_properties`) are retained as neutral hooks — the inverse of E3's allowlist, and complementary to it (`touches: privacy`). — architect (2026-07-07): §E3.3 (PostHog denylist position).
- Session id must exist even in memory/no-op mode (E4), because enrichment and session-entry props depend on it; consent-declined must still mint a session id or E6 enrichment breaks. — architect (2026-07-07): §E-cross.
- E6 slices the **same** ~4,200-line browser-core monolith as E4/E5 and builds on the shared decomposition (neutral event object + property-build order) that E4 front-loads and E5 inherits — E6 layers capture/enrichment on that substrate, it does not re-cut it. — architect (2026-07-07): §E-cross gap #3.
- Groups typing threads E3↔E6↔E2 — ensure `group()` typing flows through `defineTaxonomy` (E3) and the capture path (E6) and the SPI (E2); don't let it fall between the identity and capture epics. — architect (2026-07-07): §E-cross.

## Expansion path

New enrichment modules slot into the structured `enrichment` object additively; new capture-profile fields (per-context consent, additional toggles) are additive to a profile; deeper autocapture (rageclick, dead-click) extends the minimal port without changing the neutral surface. Wire-name mapping staying inside the adapter means a future backend re-uses all of this unchanged — one adapter, zero consumer change.
