---
id: E5-S3-retry-queue-backoff
epic: E5-CAP-transport
status: ready-for-dev
area: capture
touches: [browser, adapters]
depends_on: [E5-S2-request-batch-queue]
api_impact: additive
---

# E5-S3-retry-queue-backoff — Retry queue with exponential backoff + jitter

## Why

A flaky network or a transient 5xx must not lose events. This wraps the S2 flush POST so failed batches re-enqueue and retry on a jittered exponential schedule — but never retry a 4xx (a rejected batch stays rejected). It is also the substrate the offline-persistence story (S9) persists.

## Scope

### In

- Port `posthog-js/packages/browser/src/retry-queue.ts` (de-branded) into the browser package: an in-memory retry queue wrapping the S2 batch POST.
- Exponential backoff `base * 2**n` with a cap and **±50% jitter** (port PostHog's `3000 * 2**n` capped at 30 min; max 10 retries, 3 for network/status-0).
- **Retry network / 5xx failures only, NEVER 4xx** — a 4xx response is a permanent rejection; the batch is not re-enqueued.
- Online/offline awareness: `navigator.onLine` gate + `online`/`offline` event listeners; hold retries while offline, drain when back online.
- Drain-on-unload path stub (the real sendBeacon drain lands in S6; here, expose the drain method the retry queue calls on unload).

### Out

- The persisted-across-reloads queue — E5-S9 wraps THIS story's retry logic (S3 stays in-memory, matching PostHog; S9 adds persistence).
- Transport selection (fetch → XHR → sendBeacon) — E5-S6; S3 calls back into the S2 delivery path.
- Client rate-limiting / server back-pressure — E5-S4 (distinct from retry: rate-limiting is proactive, retry is reactive).

## Acceptance criteria

- [ ] A network failure or 5xx re-enqueues the batch and retries on an exponential schedule (`base * 2**n`) with a cap and ±50% jitter; asserted with fake timers against a mock fetch.
- [ ] A 4xx response is **never** retried — the batch is dropped from the retry queue; asserted by a test.
- [ ] The retry queue respects `navigator.onLine` and online/offline listeners: retries pause while offline and resume on reconnect.
- [ ] Retry counts match the ported policy (max 10; 3 for network/status-0).
- [ ] All retry state stays adapter-internal — no retry config or state leaks onto the neutral surface (bar A). Retry policy is not consumer-configurable in this story (defaults only).

## Technical notes

- **Retry policy (port as-is — universal mechanics).** Max 10 retries (3 for network/status-0), exponential `3000 * 2**n` capped at 30 min with ±50% jitter (`posthog-js/packages/browser/src/retry-queue.ts:11,14,27,29-32`); retries only network/5xx, **never 4xx** (`:82`); uses `navigator.onLine` + online/offline listeners (`:53-67`); drains on unload via sendBeacon (`:182-196`). — architect (2026-07-07): §E5.2.
- **In-memory only — matches PostHog.** PostHog's retry queue is `private _queue: RetryQueueElement[] = []` (`retry-queue.ts:44`) — in-memory, does not survive reloads. Keep S3 in-memory; E5-S9 adds the persisted wrapper (that is NEW WORK, not this port). — architect (2026-07-07): §E5.6.
- **Integration point.** S3 wraps the failure path of S2's real POST: S2's `flush()` POSTs the batch via the SPI `fetch()` (`browser-adapter.ts:260-266`); S3 inspects that POST's `NeutralFetchResponse.status` and, on network-error/5xx, re-enqueues for a jittered retry. The 4xx/5xx split reads the neutral `status` field directly (`adapter.ts:12`) — no response extension needed. PostHog's split is `statusCode !== 200 && (statusCode < 400 || statusCode >= 500)` (`retry-queue.ts:82`): network/status-0 and 5xx retry, 2xx succeeds, 4xx is a permanent drop.
- **Drain entry point is consumed by TWO stories.** The drain method S3 exposes is called by S6's unload handler (sendBeacon drain of the retry queue) AND is the in-memory retry structure S9 durably mirrors. Keep it a clean public-on-the-adapter-internal-class entry point so both S6 and S9 wire into it without reaching into S3's private queue.
- Reference: `posthog-js/packages/browser/src/retry-queue.ts`.

## Shipped
