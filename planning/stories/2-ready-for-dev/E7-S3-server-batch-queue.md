---
id: E7-S3-server-batch-queue
epic: E7-NODE-server-capture
status: ready-for-dev
area: node
touches: []
depends_on: [E7-S2-node-client-capture]
api_impact: additive
---

# E7-S3-server-batch-queue — Server batch queue + locked defaults

## Why

Server capture buffers events and flushes on a size or interval trigger — a server process can't POST one HTTP request per event. This story ports the de-branded batching queue with the locked R1 defaults and the drop-oldest overflow policy, so captured `NeutralEvent`s accumulate and trigger a flush without yet defining the wire (E7-S4 owns delivery).

## Scope

### In

- An in-memory server-side batch queue inside the node package: capture (E7-S2) enqueues the minted `NeutralEvent`; the queue triggers a flush on the EARLIER of `flushAt` events buffered or `flushInterval` ms elapsed (a `setTimeout`-armed interval trigger + a size trigger on enqueue).
- Locked defaults (config-overridable via `NodeAnalyticsConfig`): `flushAt = 20`, `flushInterval = 10000` (ms), `maxBatchSize = 100` (max records per flush), `maxQueueSize = 1000` (max buffered events).
- Overflow policy: at `maxQueueSize`, **drop the OLDEST** event (shift), not block, not force-flush. (A debug/diagnostic log line on drop is fine but not required in R1.)
- The flush trigger calls the delivery seam (E7-S4's `sendBatch`) — in THIS story a delivery stub/injected callback is enough; the real gzip POST + wire envelope is E7-S4. Wire the queue → delivery hand-off so E7-S4 slots in.
- `maxBatchSize` slices the queue into per-request batches (a flush drains up to `maxBatchSize` records per POST; more than that flushes in multiple batches).

### Out

- The wire envelope, gzip, config-supplied endpoint POST, node wire-mapper, 413-halving (E7-S4).
- `flush()` / `shutdown()` PUBLIC methods + drain-on-shutdown with timeout (E7-S6). This story owns the internal queue + triggers; the public lifecycle verbs come later.
- Retry/backoff (folded into E7-S4's delivery — the transient-failure path).
- Any disk/durable persistence of the queue — server queue is in-memory only (server processes are ephemeral; durability is the consumer's infra concern, per epic Out-of-scope).
- Browser transport (RequestQueue/RetryQueue/offline-queue live in `@analytics-kit/browser`; node does NOT import them).

## Acceptance criteria

- [ ] Enqueuing `flushAt` (default 20) events triggers a flush (size trigger); with fewer than `flushAt` buffered, a flush fires after `flushInterval` (default 10000ms) elapses (interval trigger).
- [ ] The queue caps at `maxQueueSize` (default 1000): enqueuing past the cap drops the OLDEST buffered event, never blocks, never force-flushes.
- [ ] A flush drains at most `maxBatchSize` (default 100) records per delivery call; a larger backlog flushes across multiple batches.
- [ ] All four defaults are config-overridable through `NodeAnalyticsConfig`; unset uses the locked defaults.
- [ ] The queue is in-memory only — no cookie/localStorage/disk persistence; node imports nothing from `@analytics-kit/browser`.
- [ ] All four gates green.

## Technical notes

- **Defaults locked** — architect (2026-07-07, epic Notes) + confirmed posthog-source-guide (2026-07-08): `flushAt=20`, `flushInterval=10000ms`, `maxBatchSize=100`, `maxQueueSize=1000`; drop-OLDEST at `maxQueueSize`. Source constants: `posthog-js/packages/core/src/posthog-core-stateless.ts:268-271`. Flush logic (size + interval trigger): `posthog-core-stateless.ts:1035-1071`. Overflow drop-oldest: `posthog-core-stateless.ts:1053-1056` (`queue.shift()`, "Queue is full, the oldest event is dropped").
- Do NOT conflate with posthog's `MAX_CACHE_SIZE = 50*1000` (`client.ts:56`) — that's the flag-called dedup cache, not the event queue. Ignore it for R1 (no flag eval).
- Port the de-branded enqueue/flush-timer from `posthog-core-stateless.ts` (the stateless base) — strip PostHog naming; the queue holds neutral `NeutralEvent`s (or their pre-wire form), and only E7-S4 maps to the `[WIRE]` shape.
- The queue→delivery seam should be an injected send callback so E7-S4's `sendBatch` slots in and E7-S6's `flush()`/`shutdown()` can force-drain it. Mirror how the browser adapter injects `send` into its `RequestQueue` (`packages/browser/src/browser-adapter.ts:272`), but node's queue is server-shaped (no beacon/unload).
- api_impact additive.

## Shipped
