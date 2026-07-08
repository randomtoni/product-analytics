---
id: E5-S9-offline-queue-persistence
epic: E5-CAP-transport
status: ready-for-dev
area: capture
touches: [browser, adapters]
depends_on: [E5-S3-retry-queue-backoff]
api_impact: additive
---

# E5-S9-offline-queue-persistence — Offline queue that survives reloads (NEW WORK)

## Why

The single BRIEF §4 requirement PostHog does NOT satisfy: an offline queue that survives a reload. PostHog's retry queue is an in-memory array only, so a reload/navigation while offline loses every buffered event. This adds a persisted-queue wrapper so events captured offline survive a reload and flush on the next load.

## Scope

### In

- **NEW WORK — not a port.** A persisted-queue wrapper around the S3 in-memory retry logic: on enqueue/retry, mirror the undelivered batches to durable storage (localStorage first; the design must leave room for an IndexedDB backend later without a neutral-surface change).
- On next load (adapter construction), rehydrate any persisted undelivered batches and hand them to the S3 retry queue to flush.
- Prune persisted entries once a batch is confirmed delivered (a 2xx), and cap the persisted size so a permanently-offline client can't grow storage unbounded (drop oldest past a cap).
- Reuse the E4 storage-backend seam (`StorageBackend` in `packages/browser/src/storage-backends.ts`) for the localStorage read/write so the persisted queue rides the same graceful-fallback machinery — but it lives under its OWN store name (it is transport buffer, not identity/super-props; do NOT mix it into the property store).
- Respect consent: an opted-out client persists nothing (the buffer is dropped, not persisted — consistent with the E4-S3 / S2 drop-not-flush contract).

### Out

- IndexedDB backend — leave the seam open; localStorage is the release-1 backend (additive upgrade later, noted in the epic Expansion path).
- Persisting anything beyond undelivered ingest batches (no persisted identity/session state — that is E4's, already durable).
- Cross-tab coordination / leader election for a shared queue — out of scope; each tab flushes its own persisted queue (dedupe on `uuid` at the backend covers double-send).

## Acceptance criteria

- [ ] Events captured while offline are written to durable storage; after a simulated reload (fresh adapter instance against the same storage), they rehydrate and flush on next load — verified by a reload test (this is THE success criterion the epic calls out).
- [ ] A confirmed-delivered (2xx) batch is pruned from durable storage; a test asserts persisted storage is empty after a successful flush.
- [ ] The persisted queue is size-capped; past the cap, oldest batches are dropped (no unbounded storage growth) — unit-tested.
- [ ] An opted-out client persists nothing — a test asserts durable storage stays empty after opt-out (E4-S3 / S2 drop-not-flush contract).
- [ ] The persisted queue lives under its own store name, separate from the property store; it does not pollute identity/super-props storage.
- [ ] All persistence stays adapter-internal — no persisted-queue config or state leaks onto the neutral surface (bar A). Dedupe on `uuid` (E5-S8) makes a double-send after reload idempotent.

## Technical notes

- **This is NEW WORK, not a port — do not present it as one.** PostHog's retry queue is an in-memory array only — `private _queue: RetryQueueElement[] = []` (`posthog-js/packages/browser/src/retry-queue.ts:44`), nothing written to disk/localStorage; PostHog's offline queue does **not** survive a reload. The BRIEF explicitly requires "offline queue (survives reloads)," so add a persisted-queue wrapper (localStorage or IndexedDB-backed), flushed on next load. — architect (2026-07-07): §E5.6 + §E-cross gap #1.
- **Wraps S3, does not replace it.** S3 stays the in-memory retry engine (matching PostHog); S9 mirrors its undelivered batches to durable storage and rehydrates on construction. Keep the wrapper thin — it is a persistence sidecar, not a reimplementation of retry.
- **Reuse the E4 storage seam, own store name.** Use the `StorageBackend` abstraction (`packages/browser/src/storage-backends.ts`) for graceful localStorage fallback, under a dedicated store name (add it to `persistence-keys.ts` alongside `storeName`/`consentStoreName`). It is transport buffer state — keep it out of the `PersistenceStore` property blob.
- **Idempotency covers double-send.** Because S8 maps `dedupeId → uuid`, a batch that was actually delivered but not yet pruned (crash between send and prune) re-sends harmlessly — the backend dedupes on `uuid`. This is why S9 depends on the retry path but leans on S8's guarantee.
- Reference for the retry structure being persisted: `posthog-js/packages/browser/src/retry-queue.ts` (the in-memory shape S9 durably mirrors).

## Shipped
