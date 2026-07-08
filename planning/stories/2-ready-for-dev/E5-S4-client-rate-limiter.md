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
- **Reading the signal may need the response extension.** Interpreting the back-pressure signal likely requires reading the POST response (body and/or headers). Coordinate with the E5-S2 `NeutralFetchResponse` forward note: if S2 did not already extend `NeutralFetchResponse` with a DOM-free header accessor, extend it additively here (keep it neutral — no vendor header/field names on the type). — E5-S2 forward note.
- Reference: `posthog-js/packages/browser/src/rate-limiter.ts`.

## Shipped
