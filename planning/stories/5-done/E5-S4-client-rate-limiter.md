---
id: E5-S4-client-rate-limiter
epic: E5-CAP-transport
status: ready-for-dev
area: capture
touches: [browser, adapters]
depends_on: [E5-S2-request-batch-queue]
api_impact: additive
---

# E5-S4-client-rate-limiter — Client token bucket + neutralized back-pressure

## Why

A runaway loop or a backend under load must not hammer the ingest endpoint. A client-side token bucket throttles proactively, and a neutralized back-pressure hook lets the adapter honor whatever slow-down signal its backend sends — without baking a vendor-specific signal into the seam.

## Scope

### In

- Port `posthog-js/packages/browser/src/rate-limiter.ts` (de-branded): a client token-bucket limiter (port PostHog's 10 events/s, burst ×10 = 100) applied at capture/enqueue time.
- Neutralize the **server back-pressure signal**: instead of reading PostHog's `quota_limited` response body verbatim, define an adapter-internal hook where the adapter interprets whatever back-pressure signal ITS backend sends (a `[WIRE]` detail), then blocks the affected batch for a cool-off window.
- The dropped-events warning event (PostHog's `$$client_ingestion_warning`) is `[WIRE]` — if surfaced at all, emit it as an adapter-internal diagnostic, not a neutral event; keep it minimal (a debug/warn hook is E12/OBS territory — do not build a diagnostics surface here).

### Out

- Retry/backoff on transient failures — E5-S3 (rate-limiting is proactive throttling; retry is reactive re-send — keep them distinct).
- A consumer-facing rate-limit config knob — defaults only this story (additive knobs can come later).
- Any observability/debug surface for dropped events — OBS area, later.

## Acceptance criteria

- [ ] A client token bucket throttles capture/enqueue at the ported rate (10 events/s, burst 100); asserted with fake timers.
- [ ] The back-pressure signal is neutralized: the adapter reads its backend's signal via an adapter-internal hook (not a hardcoded `quota_limited` body) and blocks the affected batch for a cool-off window; a second adapter could interpret a different signal with zero neutral-surface change (bar A).
- [ ] No vendor-specific back-pressure field name (`quota_limited`, `Retry-After` assumptions, etc.) appears on the neutral surface — grep-clean.
- [ ] The `$$client_ingestion_warning`-equivalent, if present, is adapter-internal `[WIRE]`, not a neutral event.

## Technical notes

- **Token bucket + server-limit handling.** Port `posthog-js/packages/browser/src/rate-limiter.ts`: client token-bucket (10 events/s, burst ×10 = 100; `:10-11,52-59`). `[WIRE]`: PostHog reads a response **body** `quota_limited: string[]` (not a `Retry-After` header) and blocks that batch-key for 60 s (`:95-108`) — neutralize by having the adapter interpret whatever back-pressure signal its backend sends. The `$$client_ingestion_warning` event (`:9,66-74`) is `[WIRE]`. — architect (2026-07-07): §E5.3.
- **Read the back-pressure signal off the response BODY — no `NeutralFetchResponse` extension.** The signal is body-borne, not header-borne: PostHog reads `quota_limited: string[]` via `JSON.parse(httpResponse.text)` (`rate-limiter.ts:95-108`). The shipped `NeutralFetchResponse` already exposes `text()`/`json()` (`adapter.ts:11-15`), so read the signal off those directly. Do NOT extend `NeutralFetchResponse` with a header accessor — that hedge from the S2 forward-note was a false lead and is struck. The neutral type stays unchanged; only the adapter-internal interpretation of the body is `[WIRE]`. — story-refiner (architect-confirmed, 2026-07-08).
- Reference: `posthog-js/packages/browser/src/rate-limiter.ts`.

## Shipped
- > Reviewer suggestion (2026-07-08, forward note): `RateLimiterOptions.eventsPerSecond`/`burstLimit` are dead config until a later additive-knob story wires them through `BrowserAdapterOptions`/`AnalyticsConfig` (defaults-only this story — correct). Note so the option surface isn't mistaken for already-wired.
- > Reviewer suggestion (2026-07-08, cosmetic): `interpretBackPressure` doc says "called for EVERY response" — a network THROW from `this.fetch` propagates before it runs (correct — no body to interpret). Tighten to "every completed response".
- > Reviewer note (2026-07-08, forward note for S6): `interpretBackPressure` consumes the response body via `text()` once inside `postBatch` (single-use stream). Today only `status` is read upward — no conflict. If S6 needs to read the body upward too, it must tee/cache.

## Shipped

> Captured by `implement-epics` on 2026-07-08.

- **Files added (browser):** `rate-limiter.ts` (`RateLimiter`: token bucket 10/s burst-100 `consumeToken()` + per-scope cool-off `isCoolingOff(scope)`/`interpretBackPressure(response)` keyed by neutral `DEFAULT_BATCH_SCOPE`; `[WIRE]` body-interpretation INJECTED as `BackPressureInterpreter`), `back-pressure-interpreter.ts` (the ONE `[WIRE]` module: reads `quota_limited` off `response.text()`, confined to one `const LIMITED_SCOPES_FIELD`) + tests
- **Files changed:** `browser-adapter.ts` (token gate in `capture()` PRE-enqueue peer to bot gate; cool-off gate at top of `postBatch()` returns `undefined`=no-op to S3; body-read after `fetch`). SPI unchanged.
- **New public API:** none — all rate-limit state adapter-internal (bar A); defaults-only (no consumer knob)
- **Tests added:** browser +27 (rate-limiter 12: burst/refill/ceiling/runaway/cool-off/**bar-A second-interpreter `retry_after_ms`**; interpreter 7: named-scope/collapse/empty/non-JSON; adapter 8: 101st-dropped-pre-queue, refill, body-signal-blocks-60s, clean-body-no-cooloff, read-off-text-not-header, no-neutral-vocab) → 327; seam 128 unchanged
- **Commit:** `E5-S4-client-rate-limiter — Client token bucket + neutralized back-pressure` on `core-cycle`
- **Reviewer notes:** 0 critical, 3 suggestions (dead knob options, doc wording, S6 body single-use); S2/S3/E4 green
- **Cross-story seams exposed:** S4 sits at two orthogonal seams leaving the pipeline intact — token gate (pre-enqueue, peer to bot) + cool-off gate + body-read (inside `postBatch`, ABOVE the fetch so a cooled-off batch never reaches **S5** compression). `undefined=nothing-sent` is the only cross-path signal (no `RequestQueue`/`RetryQueue`/`send` touch). **S6:** a `sendBeacon` path with no readable body → `text()`=''→ no cool-off (correct fire-and-forget); body is single-use in `postBatch` (tee if reading upward). Bar-A back-pressure seam = the injected `BackPressureInterpreter` (a 2nd adapter swaps only that).

## Follow-up

> E5 post-close improvement pass, 2026-07-08 (commit follows). Reviewer-verified, no regression.

- **Doc wording tightened** — `interpretBackPressure` now documents it runs for "every COMPLETED response" (a network throw propagates before it runs — no body to interpret). (Addresses the S4 cosmetic suggestion.)
- Skipped-with-reason: the dead `eventsPerSecond`/`burstLimit` knob options wait for a later config-knob story (defaults-only was this epic's scope); the response-body single-use note was already addressed by S6.
