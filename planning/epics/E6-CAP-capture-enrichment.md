---
id: E6-CAP-capture-enrichment
status: planned
area: capture
touches: [browser, privacy]
api_impact: additive
blocked_by: [E5-CAP-transport]
updated: 2026-07-07
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

- **E6-S1 track / page primitives** *(additive, no deps)* — neutral `track(event, props)` and `page(name?, props?)`; neutral event naming (e.g. `pageview`), framework-router-safe manual pageview.
- **E6-S2 pageleave** *(additive, depends on E6-S1)* — port `page-view` manager: time-on-page/bounce duration on a `pageleave` event, fired on unload via sendBeacon; toggle mirrors PostHog's `if_capture_pageview` default semantics.
- **E6-S3 context enrichment port** *(additive, no deps)* — de-brand page context (`current_url`/`pathname`/`host`/`referrer`/`referring_domain`), device/browser/OS context, timezone, per-event timestamp → neutral keys.
- **E6-S4 UTM / campaign auto-parse** *(additive, depends on E6-S3)* — parse `utm_*` + click-ids from the URL into neutral keys; initial variants set-once.
- **E6-S5 structured `enrichment` opt-out config** *(additive, depends on E6-S3)* — one structured object with a boolean/options per enrichment module (each individually disable-able), replacing PostHog's scatter of flat booleans.
- **E6-S6 pluggable country source** *(additive, depends on E6-S5)* — consumer-injected `countrySource` + a GeoIP disable switch; the injected value is consumer-supplied ⇒ subject to the E3 allowlist.
- **E6-S7 per-context capture profiles (DESIGNED)** *(additive, depends on E6-S1, E6-S5)* — consumer names contexts (e.g. `marketing`/`app`), each a profile (autocapture on/off, manual vs auto pageview, enrichments, consent default); a single provider holds shared identity/session/transport, `context(name)` returns a scoped view. **No PostHog analogue** — own design note.
- **E6-S8 autocapture (opt-in, default off)** *(additive, depends on E6-S7)* — minimal port: capture clicks/input-changes/form-submits → element metadata; **drop** the remote-config gate; expose as a per-context-profile flag, default off.

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
