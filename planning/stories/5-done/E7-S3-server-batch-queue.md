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
- **Node re-implements its OWN queue — settled, not shared.** The browser's `RequestQueue` (`packages/browser/src/request-queue.ts`) is browser-package-local and browser-saturated (it feeds the browser transport, pairs with a `RetryQueue`/offline-queue, and carries no drop-oldest/`maxQueueSize` overflow — that's server-shaped, not browser-shaped). Node MUST NOT import it (hard isolation bar). Node's queue is a fresh, small in-memory buffer ported de-branded from `posthog-core-stateless.ts` (server shape: size+interval trigger, `maxBatchSize` slicing, drop-oldest at `maxQueueSize`, no beacon/unload). This is genuinely a different primitive, not a shared one — do NOT hoist a queue to the seam.
- The queue→delivery seam should be an injected send callback so E7-S4's `sendBatch` slots in and E7-S6's `flush()`/`shutdown()` can force-drain it. The *pattern* (inject `send` into the queue) mirrors how the browser adapter injects `send` into its `RequestQueue` (`packages/browser/src/browser-adapter.ts:272`) — but node writes its own queue class; it reuses only the callback-injection SHAPE, not the browser code.
- **`setTimeout` typing:** the interval trigger arms a `setTimeout` whose handle types as `NodeJS.Timeout` (or `ReturnType<typeof setTimeout>` to stay portable) — needs the `@types/node` devDep added in E7-S2. Clear it on drain (relevant to E7-S6's quiesce).
- api_impact additive.

## Shipped
- > Reviewer suggestion (2026-07-08): add one focused test for the "interval armed BEFORE the buffer crosses flushAt, then upgraded to a size flush" ordering (currently only implicitly covered) — asserts no redundant empty delivery. Behavior already correct via `drainAndSend`→`clearTimers`.
- > Reviewer suggestion (2026-07-08, for S4): `track()` swallows send rejections (`.catch(()=>undefined)`) — correct for S3 (no retry yet), but this swallowed-rejection path is exactly where S4's retry/backoff must hook in so failures aren't silently lost.

## Shipped

> Captured by `implement-epics` on 2026-07-08.

- **Files added (node):** `batch-queue.ts` (node-OWN generic `BatchQueue<T>` de-branded from `posthog-core-stateless.ts`: locked defaults 20/10000/100/1000, size+interval earlier-of triggers, deferred `setTimeout(0)` size-flush, `maxBatchSize` slicing into multiple per-delivery batches, drop-oldest at `maxQueueSize`, injected `send` seam, `flushNow()`/`drain()` timer-clearing) + test
- **Files changed:** `node-analytics.ts` (client owns `BatchQueue<NeutralEvent>` from the 4 config knobs; `capture` enqueues; `SendBatch` delivery-seam type, injectable 2nd ctor param defaulting to no-op stub; retired `EventBuffer`), **DELETED** `event-buffer.ts` (retired the single-impl S2 stub — resolves the S2 reviewer `drain()`-not-on-interface flag by removal)
- **New public API:** none — queue + `SendBatch` adapter-internal (not exported from `index.ts`)
- **Deliberate reference deviations (both regression-tested):** DROPPED the `maxBatchSize = Math.max(flushAt, maxBatchSize)` clamp (makes maxBatchSize an independent per-delivery cap floored at 1 → 250→100/100/50); KEPT `maxQueueSize = Math.max(maxQueueSize, flushAt)` (a cap below flushAt wedges the size trigger) + `flushAt >= 1`
- **Tests added:** node +32 (batch-queue 29: defaults, size/interval/earlier-of fake-timer, drop-oldest at cap never-block never-force-flush, maxBatchSize slicing + anti-clamp, config overrides + floors, injected-send + flushNow-awaits-in-flight + rejection-doesn't-escape + one-deferred-drain-per-burst + drain-quiesce; adapter config-threads-into-queue via send-spy) → 50; seam 166 unchanged
- **Commit:** `E7-S3-server-batch-queue — Server batch queue + locked defaults` on `core-cycle`
- **Reviewer notes:** 0 critical, 2 suggestions (interval-armed-then-size test; S4 retry-hook on the swallowed-rejection path)
- **Cross-story seams exposed:** **S4** slots `sendBatch` into the injected `send` closure (ctor 2nd arg `SendBatch = (batch: NeutralEvent[]) => Promise<void>`) — zero queue reshaping; owns the wire envelope/gzip/endpoint-POST/`dedupeId→uuid`/413-halving BELOW the seam; retry/backoff hooks the swallowed-rejection path. (Architect carry: the reference's 413-halving permanently mutates maxBatchSize — S4 decides separate-runtime-field vs in-flight-only; keeping maxBatchSize independent here makes either clean.) **S6** `flush()`→`queue.flushNow()` (drain+await in-flight), `shutdown()`→`queue.drain()` (take-all, clears both timers so no dangling `setTimeout` pins the event loop).

## Follow-up

> E7 post-close improvement pass, 2026-07-08 (commit follows). Reviewer-verified, no regression.

- **Interval-armed-then-size test** — added: arms the interval (buffer < flushAt), half-elapses to prove it's armed, crosses flushAt (deferred size-flush), asserts exactly ONE delivery of all records, then advances the FULL interval window to prove `clearTimers()` cancelled the armed interval (no redundant empty send). (Addresses the S3 reviewer suggestion.)
