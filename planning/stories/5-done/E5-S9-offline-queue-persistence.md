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
- **Reuse the E4 storage seam, own store name.** Use the `StorageBackend` abstraction (`packages/browser/src/storage-backends.ts`) for graceful localStorage fallback, under a dedicated store name (add a `queueStoreName(key)` helper to `persistence-keys.ts` alongside `storeName`/`consentStoreName`, using the same `sanitize` + a distinct prefix). It is transport buffer state — keep it out of the `PersistenceStore` property blob.
- **Persist format: wrap the batch array in an object.** The `StorageBackend` contract stores JSON: `set(name, value: unknown)` JSON-stringifies, but the typed reader `parse(name)` returns `StorageEntry | null` = `Record<string, unknown>` (`storage-backends.ts:5,19`) — an OBJECT shape, not an array. Persisting a bare `Batch[]` would read back as a type-mismatched object. So persist under an object envelope, e.g. `{ batches: [...] }`, and read via `parse(name)?.batches` (or use the raw `get(name)` + your own `JSON.parse` if you want an array directly — but the object envelope keeps you on the typed `parse` path and leaves room for a version/metadata field later). Pin this format in a test so a later IndexedDB backend round-trips the same envelope.
- **Which storage backend, and the consent interaction.** Reuse `localStorageBackend` (`storage-backends.ts:104-153`) directly for the durable queue — do NOT route it through the consent-gated `buildPropsBackend`/`PersistenceStore`, whose backend collapses to memory under non-granted consent (`browser-adapter.ts:81-87`). Instead, gate persistence explicitly on consent in the wrapper: an opted-out client (`getConsentState() !== 'granted'`, or the same drop-on-`setConsentState('denied')` hook S2 wires) persists nothing and drops any persisted queue. This keeps the "opted-out persists nothing" AC true without entangling the transport buffer in the identity-store's consent-swap machinery.
- **Idempotency covers double-send.** Because S8 maps `dedupeId → uuid`, a batch that was actually delivered but not yet pruned (crash between send and prune) re-sends harmlessly — the backend dedupes on `uuid`. This is why S9 depends on the retry path but leans on S8's guarantee.
- Reference for the retry structure being persisted: `posthog-js/packages/browser/src/retry-queue.ts` (the in-memory shape S9 durably mirrors).

## Shipped
- > Reviewer suggestion (2026-07-08, improvement-pass candidate): `rehydrate()` re-schedules every persisted batch at `attempt: 0`, discarding the pre-reload retry-attempt count — deliberate (fresh load = fresh delivery opportunity; `uuid` dedupe makes re-send harmless; a 4xx prunes on first re-send). But the size cap bounds STORAGE, not retry-attempts-across-reloads. Add a one-line comment at the rehydrate site documenting attempt-reset-on-reload is deliberate, so a future reader doesn't "fix" it by persisting the attempt count (which would then need to enter the envelope + a format-version).
- > Reviewer suggestion (2026-07-08, IndexedDB follow-up): the size cap is a count of BATCHES (`DEFAULT_MAX_PERSISTED_BATCHES=100`), not a byte budget — a consumer capturing very large events could approach the ~5MB localStorage quota with <100 batches (`localStorageBackend.set` then fails silently, safe degradation but invisible). A byte-aware cap becomes natural with the IndexedDB backend.
- > Reviewer suggestion (2026-07-08, perf): `persist()` runs a full `JSON.stringify`+`setItem` synchronously per send outcome (incl. pure-grow). Correct+bounded; if it shows on a profile, coalesce/debounce the mirror like the property store's `SAVE_DEBOUNCE_MS=250`.

## Shipped

> Captured by `implement-epics` on 2026-07-08.

- **Files added (browser):** `offline-queue.ts` (`OfflineQueueStore<T>`: `persist(snapshot)` capped overwrite-mirror, `rehydrate()` read-then-clear drain, `drop()`; consent-gated, object-envelope, `Array.isArray` fail-closed) + test
- **Files changed:** `browser-adapter.ts` (construct via `localStorageBackend` directly gated on live `getConsentState()==='granted'`; rehydrate at construction → `scheduleRetry(batch,0)`; mirror `retryQueue.snapshot()` at tail of `sendBatchWithRetry`; drop durable queue in `setConsentState('denied')`), `persistence-keys.ts` (+`queueStoreName(key)` distinct `analytics_kit_queue` prefix)
- **New public API:** none — all persistence adapter-internal (bar A); SPI unchanged
- **Persist format:** object envelope `{ batches: [...] }` (room for a version field → IndexedDB later), read via `parse(name)?.batches`
- **Tests added:** browser +25 (offline-queue 15: round-trip/envelope/prune/size-cap/consent-gate/read-then-clear/corrupt-fail-closed; adapter 10: **THE reload rehydrate+flush**, 2xx-prunes, first-try-200-never-persisted, size-cap-bounded, opted-out-persists-nothing, optout-drops-persisted, own-store-name bidirectional, envelope, uuid-replay idempotent, bar-A) → 396; seam 128
- **Commit:** `E5-S9-offline-queue-persistence — Offline queue that survives reloads (NEW WORK)` on `core-cycle`
- **Reviewer notes:** 0 critical, 3 suggestions (attempt-reset doc; byte-budget cap; per-outcome write debounce); S1..S8 + E4 green
- **Cross-story seams / scope boundary:** wraps S3 (mirrors `snapshot()`, does NOT reimplement retry). The `RequestQueue`-buffer pre-flush hard-crash window is a documented R1 non-goal (S6 unload beacon covers tab-close; "survives a reload" = the durable retry mirror). **E6:** track/page/pageleave inherit offline-persistence for free via `runCapturePipeline`→`enqueue`, but only batches that reached the retry queue are mirrored — a pageleave at unload relies on the S6 beacon, not S9. **E7 (node):** `dedupeId` is a neutral `NeutralEvent` field → node inherits the S8 idempotency guarantee; keep the batch-envelope + dedupe contract stable.

## Follow-up

> E5 post-close improvement pass, 2026-07-08 (commit follows). Reviewer-verified, no regression.

- **Attempt-reset gotcha comment** — a one-line note at the `rehydrate()` re-schedule site that attempt-reset-on-reload is deliberate (uuid dedupe makes re-send harmless; a 4xx prunes on first re-send) — so a future reader doesn't "fix" it by persisting the attempt count. (Addresses the S9 reviewer suggestion.)
- Skipped-with-reason: the byte-budget cap is an IndexedDB follow-up (count-cap satisfies "no unbounded growth"); the per-outcome-write debounce is a perf-only change gated on profiling.
