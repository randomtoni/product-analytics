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
- The pageleave carries library-computed duration: `duration = now − currentPageview.timestamp` (from the E6-S1 record), plus the pageview id / pathname link. Neutral keys only (de-brand posthog-js `$prev_pageview_duration` / `$prev_pageview_id` / `$prev_pageview_pathname`, `page-view.ts:139-158`). These are **library-computed ⇒ trusted** (added downstream of the E3 facade allowlist — no allowlist gating).
- Fire only when (a) a current-pageview record exists (a `page` was captured this session) and (b) the pageleave toggle is on. R1: gate on a browser-adapter config flag with the posthog-js default semantics — pageleave defaults on when pageview capture is in use (`capture_pageleave: 'if_capture_pageview'`, `posthog-core.ts:243`). The final wiring of this toggle into the structured `enrichment` object lands in E6-S5; here, read it as a plain adapter option so E6-S2 is testable standalone.
- Idempotent via the existing `unloadDrained` latch — a real unload fires several lifecycle events; the pageleave mints at most once.

### Out

- The structured `enrichment` config object that will own the `pageleave` toggle — E6-S5 (this story reads a plain boolean option; S5 rewires it).
- Scroll-depth props (`$prev_pageview_*_scroll`/`*_content`): out this release.
- A public `pageleave()` facade verb — explicitly rejected (see Technical notes). Pin stays 15.
- History-change auto-pageview — out (E6-S1 Out).

## Acceptance criteria

- [ ] On unload (pagehide/visibilitychange-hidden/beforeunload), when a `page` was captured this session and the toggle is on, exactly one `pageleave` event is minted with a correct duration (≈ time between the `page` capture and unload) and beacon-drained — verifiable by driving `unload()` directly (it is `@internal`-public for exactly this).
- [ ] The pageleave rides the beacon drain, not a normal interval/size batch POST (it is enqueued synchronously immediately before `drain()`).
- [ ] No pageleave fires when no `page` was captured this session, or when the toggle is off.
- [ ] The pageleave's computed keys are neutral (no `$`-prefix) and are NOT allowlist-gated (library-computed ⇒ trusted). (bar A)
- [ ] `keyof AnalyticsProvider` stays the frozen fifteen members — no facade verb added.
- [ ] All four gates green.

## Technical notes

- **Adapter-internal, NOT a facade verb — pin stays 15.** PostHog never exposes `pageleave` publicly (`posthog-core.ts:1085-1105` fires it internally); a manual `pageleave()` verb would double-fire or produce a wrong duration, and a node adapter has no unload — so it would pollute the neutral seam. Fire it from the browser adapter only. — architect (2026-07-08): §E6 Q1.
- **Mint order (load-bearing):** inside `unload()`, after `if (unloadDrained) return; unloadDrained = true`, before `this.queue.drain()`. `capture()` runs `queue.enable(); queue.enqueue(...)`; because you call it synchronously just before `drain()`, the pageleave sits in the buffer that `drain()` beacons — no special transport flag needed. Mint it BEFORE the `url === undefined` branch so a no-target unload harmlessly drains-and-discards it. — architect (2026-07-08): §E6 Q1.
- The pageleave inherits `capture()`'s bot gate + rate limiter by construction (desirable — a bot shouldn't emit one). No special handling. — architect (2026-07-08): §E6 Q1.
- **Duration source:** posthog-js computes `(timestamp − previousPageView.timestamp) / 1000` seconds (`page-view.ts:157`). De-brand the key; pick seconds-vs-ms deliberately and document it (posthog uses seconds). Reads the E6-S1 current-pageview record. — posthog-source-guide (2026-07-08).
- Toggle default semantics: `capture_pageleave` = `'if_capture_pageview'` (`posthog-core.ts:243`) — pageleave on when pageview capture is on. Neutral names `pageview`/`pageleave`; `$pageleave` is [WIRE]. — architect (2026-07-07): epic §E6.3.

## Shipped
