---
id: E6-S2-pageleave-unload
epic: E6-CAP-capture-enrichment
status: ready-for-dev
area: capture
touches: [browser]
depends_on: [E6-S1-pageview-state-page-typing]
api_impact: additive
---

# E6-S2-pageleave-unload — pageleave (adapter-internal, minted at unload)

## Why

A `pageleave` event carries time-on-page, which is only correct when minted at the unload instant and delivered on the beacon drain. This lands it as an adapter-internal event riding the existing E5 unload/beacon path — no new facade verb.

## Scope

### In

- Mint a neutral `pageleave` event **inside `BrowserAdapter.unload()`**, at the top, **after** the `unloadDrained` latch flips and **before** `this.queue.drain()`. Route it through `this.capture(...)` so it lands in the batch buffer that the very next `drain()` beacons — it rides the beacon by ordering, exactly like posthog-js `_handle_unload` (`posthog-core.ts:1093/1099-1104`).
- The pageleave carries library-computed duration `duration = (now − currentPageview.timestamp) / 1000` **in SECONDS** (posthog divides ms by 1000, `page-view.ts:157`; pin seconds and document the unit), plus the pageview id / pathname link. Neutral keys only (de-brand posthog-js `$prev_pageview_duration` / `$prev_pageview_id` / `$prev_pageview_pathname`, `page-view.ts:139-158`). These are **library-computed ⇒ trusted** (added downstream of the E3 facade allowlist — no allowlist gating).
- Fire only when (a) a current-pageview record exists (a `page` was captured this session) and (b) the pageleave toggle is on. R1: gate on a browser-adapter config flag with the posthog-js default semantics — pageleave defaults on when pageview capture is in use (`capture_pageleave: 'if_capture_pageview'`, `posthog-core.ts:243`). The final wiring of this toggle into the structured `enrichment` object lands in E6-S5; here, read it as a plain adapter option so E6-S2 is testable standalone.
- Idempotent via the existing `unloadDrained` latch — a real unload fires several lifecycle events; the pageleave mints at most once.

### Out

- The structured `enrichment` config object that will own the `pageleave` toggle — E6-S5 (this story reads a plain boolean option; S5 rewires it).
- Scroll-depth props (`$prev_pageview_*_scroll`/`*_content`): out this release.
- A public `pageleave()` facade verb — explicitly rejected (see Technical notes). Pin stays 15.
- History-change auto-pageview — out (E6-S1 Out).

## Acceptance criteria

- [ ] On unload (pagehide/visibilitychange-hidden/beforeunload), when a `page` was captured this session and the toggle is on, exactly one `pageleave` event is minted with a correct duration **in seconds** (≈ elapsed time between the `page` capture and unload) and beacon-drained — verifiable by driving `unload()` directly (it is `@internal`-public for exactly this).
- [ ] The pageleave rides the beacon drain, not a normal interval/size batch POST (it is enqueued synchronously immediately before `drain()`).
- [ ] No pageleave fires when no `page` was captured this session, or when the toggle is off.
- [ ] The pageleave's computed keys are neutral (no `$`-prefix) and are NOT allowlist-gated (library-computed ⇒ trusted). (bar A)
- [ ] `keyof AnalyticsProvider` stays the frozen fifteen members — no facade verb added.
- [ ] All four gates green.

## Technical notes

- **Adapter-internal, NOT a facade verb — pin stays 15.** PostHog never exposes `pageleave` publicly (`posthog-core.ts:1085-1105` fires it internally); a manual `pageleave()` verb would double-fire or produce a wrong duration, and a node adapter has no unload — so it would pollute the neutral seam. Fire it from the browser adapter only. — architect (2026-07-08): §E6 Q1.
- **Mint order (load-bearing):** inside `unload()`, after `if (unloadDrained) return; unloadDrained = true`, before `this.queue.drain()`. `capture()` runs `queue.enable(); queue.enqueue(...)`; because you call it synchronously just before `drain()`, the pageleave sits in the buffer that `drain()` beacons — no special transport flag needed. Mint it BEFORE the `url === undefined` branch so a no-target unload harmlessly drains-and-discards it. — architect (2026-07-08): §E6 Q1.
- The pageleave inherits `capture()`'s bot gate + rate limiter by construction (desirable — a bot shouldn't emit one). No special handling. — architect (2026-07-08): §E6 Q1.
- **S2↔S3 ordering note:** because the pageleave routes through `this.capture()`, once E6-S3 lands its enrichment step inside `runCapturePipeline`, the pageleave will also carry the fresh page/device/referrer context — desirable and matches posthog (a pageleave is a normal enriched event). No extra work in S2, but do NOT special-case the pageleave out of the pipeline. When both are present, run E6-S3 first is NOT required (S2/S3 are independent roots via S1); they compose cleanly regardless of build order because both only add to the pipeline/capture path.
- **Duration source:** posthog-js computes `(timestamp − previousPageView.timestamp) / 1000` seconds (`page-view.ts:157`). De-brand the key; pick seconds-vs-ms deliberately and document it (posthog uses seconds). Reads the E6-S1 current-pageview record. — posthog-source-guide (2026-07-08).
- Toggle default semantics: `capture_pageleave` = `'if_capture_pageview'` (`posthog-core.ts:243`) — pageleave on when pageview capture is on. Neutral names `pageview`/`pageleave`; `$pageleave` is [WIRE]. — architect (2026-07-07): epic §E6.3.

## Shipped
- > Reviewer suggestion (2026-07-08, improvement-pass candidate): the `isPageView`-not-on-wire crux is compiler-guaranteed (`WireEvent` closed interface, `mapEventToWire` builds field-by-field) but has no DIRECT regression test — add `expect(wire).not.toHaveProperty('isPageView')` (mirroring the `$insert_id` `containsInsertId` deep-scan) as belt-and-braces against a future refactor that spreads the event into `base`.
- > Reviewer note (2026-07-08): the pageleave's `prev_pageview_pathname`/`prev_pageview_id` are pinned to the pageview-mint instant (record-time) while `distinctId` is the unload-instant actor — correct (matches posthog); flagged so a future reader doesn't "fix" record-time pathname to unload-time.

## Shipped

> Captured by `implement-epics` on 2026-07-08.

- **PART A (blocking discriminator, architect-chosen):** `NeutralEvent.isPageView?: true` neutral presence-only marker; facade `page()` stamps it (named + nameless) via `buildEvent(...,true)`, `track()` never; pipeline `trackPageview` keys off `event.isPageView` (NOT `event.event==='page'`) → **named `page('/dashboard')` now sets the record**. `wireEventName()` maps marker→`$pageview` + reserved `pageleave`→`$pageleave` (`[WIRE]` confined to browser `persistence-keys.ts`). `isPageView` structurally cannot reach the wire body (`WireEvent` closed interface).
- **Files changed (seam):** `neutral-event.ts` (+`isPageView?: true`), `analytics-provider.ts` (`page()` stamps it), `taxonomy.ts` (+`RESERVED_PAGELEAVE_EVENT='pageleave'`), `index.ts` (barrel-export)
- **Files changed (browser):** `browser-adapter.ts` (`trackPageview` marker-keyed; `capturePageleave` option; pageleave minted in `unload()` after latch/before drain riding beacon, seconds duration, neutral `prev_pageview_duration|id|pathname`, NOT allowlist-gated), `persistence-keys.ts` (+`PAGEVIEW_WIRE_EVENT='$pageview'`/`PAGELEAVE_WIRE_EVENT='$pageleave'`), `wire-mapper.ts` (`wireEventName()`)
- **New public API:** none — `isPageView` is a neutral `NeutralEvent` marker (E2 shape-pin extended in lockstep to `true | undefined`); pin stays 15; no facade verb
- **Tests added:** seam +6 (139), browser +19 (433) — named/nameless stamps, named-page-sets-record (S1 pin flipped), pageleave seconds/beacon/toggle-off/no-page/idempotent/neutral-keys/not-gated/bot-gate, wire-mapper `$pageview`/`$pageleave`
- **Commit:** `E6-S2-pageleave-unload — pageleave (adapter-internal, minted at unload)` on `core-cycle`
- **Reviewer notes:** 0 critical, 2 suggestions (direct isPageView wire-absence test; pathname/distinctId timing note)
- **Cross-story seams exposed:** **S3** enrichment auto-applies to the pageleave (routes through `capture()`→`runCapturePipeline`) — do NOT special-case it out. **S4** unchanged (reuses `lastSeenSessionId`/`detectSessionRotation`). **S5** rewires `BrowserAdapterOptions.capturePageleave` (plain boolean, default `!== false`) into the structured `enrichment` object + extends the `AnalyticsConfig` shape-pin. `[WIRE]` name-mapping pattern established in `wireEventName()` (marker-keyed pageview, reserved-name-keyed pageleave/merge).

## Follow-up

> E6 post-close improvement pass, 2026-07-08 (commit follows). Reviewer-verified, no regression (seam 153 / browser 584 green).

- **Direct `isPageView` wire-absence test** — added `expect(wire).not.toHaveProperty('isPageView')` to the pageview mapping test, belt-and-braces the closed-`WireEvent` guarantee against a future refactor that spreads the event into `base`. (Addresses the S2 reviewer suggestion.)
