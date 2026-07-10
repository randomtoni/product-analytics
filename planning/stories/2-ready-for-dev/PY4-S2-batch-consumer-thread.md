---
id: PY4-S2-batch-consumer-thread
epic: PY4-NODE-server-capture
status: ready-for-dev
area: node
touches: [adapters]
depends_on: [PY4-S1-server-adapter-capture-and-selection]
api_impact: additive
---

# PY4-S2-batch-consumer-thread — Batch queue + background daemon-thread consumer

## Why

A server process can't POST one HTTP request per event — it buffers and flushes on a size or interval trigger. This story builds the Python consumer model: a bounded queue fed by `adapter.capture` and drained by a background daemon thread, flushing on `flush_at` OR `flush_interval`, with the **drop-OLDEST overflow policy that matches the TS cross-port contract** (NOT posthog-python's drop-newest). It plugs into the sync-client posture PY2-S4 locked and the `sync_mode` flag it defined. It is the Python realization of TS `E7-S3` (server batch queue), realized with a real background thread (the Python posture, grounded in `posthog-python/posthog/consumer.py`).

## Scope

### In

- A bounded batch buffer + a background **daemon `Thread`** consumer (in the server-adapter module / a `consumer.py`): `adapter.capture` enqueues the minted `NeutralEvent`; the consumer thread drains it, flushing on the EARLIER of `flush_at` events buffered OR `flush_interval` seconds elapsed (a block-with-timeout `queue.Queue.get` loop — the size-OR-interval trigger, same as TS `batch-queue.ts`).
- Locked defaults (config-overridable, additive to `AnalyticsConfig`, `extra="forbid"`): `flush_at = 20`, `flush_interval = 10.0` (seconds), `max_batch_size = 100` (max records per delivery), `max_queue_size = 1000` (max buffered events). (Names/units are the Python-idiomatic form of the TS `flushAt`/`flushInterval`/`maxBatchSize`/`maxQueueSize`.)
- **Overflow = drop-OLDEST at `max_queue_size`** (the load-bearing cross-port contract — see the pin in Technical notes): at cap, evict the OLDEST buffered event before enqueuing the new one; never block, never force-flush. A bare `queue.Queue.put(block=False)` + `except Full` drops the NEW event (drop-newest) = WRONG. Use a manual bound (a `collections.deque(maxlen=...)` under a lock, or evict-oldest-before-put) so the OLDEST is the one dropped.
- `max_batch_size` slices the drain into per-delivery batches (a flush drains up to `max_batch_size` records per delivery call; a larger backlog flushes across multiple batches).
- The `sync_mode` bypass (the flag PY2-S4/`config.py` already define): `sync_mode=True` ⇒ no background thread, delivery inline on the calling thread; `sync_mode=False` (default) ⇒ the daemon thread. The daemon thread is `daemon=True` (never blocks process exit) + registered for an `atexit` join.
- The queue→delivery seam is an injected send callback so PY4-S3's real wire delivery slots in and PY4-S4's `flush`/`shutdown` can force-drain it (this story wires the queue→delivery hand-off with a stub/injected delivery; the real gzip POST is PY4-S3).

### Out

- The wire envelope / gzip / `dedupe_id`→`uuid` / config endpoint POST / wire-mapper — **PY4-S3** (this story consumes the injected delivery callback).
- Retry / 413-halving / fetch-failure normalization — **PY4-S4** (folded into delivery).
- Public `flush()` / `shutdown()` drain-with-timeout + quiesce — **PY4-S4** (this story owns the internal queue + triggers + thread; the lifecycle drive is PY4-S4).
- Any disk/durable persistence of the queue — in-memory only (ephemeral server; durability is the consumer's infra concern).
- An asyncio consumer — explicitly NOT this cycle (the sync+thread posture is locked; PY2-S4).

## Acceptance criteria

- [ ] Enqueuing `flush_at` (default 20) events triggers a flush (size trigger); with fewer buffered, a flush fires after `flush_interval` (default 10s) elapses (interval trigger, via block-with-timeout `get`).
- [ ] **Overflow drops the OLDEST event (named test — this story OWNS the pin):** at `max_queue_size` (default 1000), enqueuing past the cap evicts the OLDEST buffered event, never blocks, never force-flushes. A dedicated named test asserts the OLDEST event is the one evicted at cap — **a drop-newest implementation (bare `queue.Queue` `put(block=False)`/`except Full`) MUST fail this test.** (This is the exact cross-port contract break the refiner flagged.)
- [ ] A flush drains at most `max_batch_size` (default 100) records per delivery; a larger backlog flushes across multiple batches.
- [ ] `sync_mode=True` delivers inline (no thread started); `sync_mode=False` uses a `daemon=True` background thread joined via `atexit`; the thread never blocks process exit.
- [ ] All four defaults are config-overridable through `AnalyticsConfig`; unset uses the locked defaults.
- [ ] The queue is in-memory only — no disk/cookie persistence.
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token; `grep -ri posthog` over the new files clean (source-level).

## Technical notes

- **⚠ DROP-OLDEST — the load-bearing cross-port contract (this story OWNS the pin + test).** — from the epic Notes + the refiner flag: the TS contract (`ts/packages/node/src/batch-queue.ts`, `posthog-core-stateless.ts:1053-1056` `queue.shift()`) drops the OLDEST at cap. **posthog-python's `client.py:1711-1715` drops the NEWEST — that is the DE-BRANDING reference (wire/threading/naming), NOT the contract reference; its overflow idiom MUST NOT be copied.** A bare `queue.Queue` only cheaply supports drop-newest (`put(block=False)` raises `Full`, you drop the new event) — so this is a REAL trap. Implement a manual bound: `collections.deque(maxlen=max_queue_size)` (auto-evicts oldest on append) under a `threading.Lock`, or an explicit evict-oldest-before-put. A named test MUST assert the OLDEST is evicted (fill to cap with identifiable events, enqueue one more, assert the first is gone and the newest is present) — a drop-newest impl fails it. This is the exact cross-port break the refiner named.
- **Consumer thread model** — architect (2026-07-09, Cluster 2, high): `queue.Queue` fed by `capture`, drained by a background daemon `Thread` (block-with-timeout `get`, flush on size OR interval — same trigger as TS `batch-queue.ts`). DE-BRAND the thread/loop idiom FROM `posthog-python/posthog/consumer.py` (its `Consumer(Thread)` block-with-timeout drain) — but the OVERFLOW policy is the TS contract (drop-oldest), NOT posthog-python's. `daemon=True` so it never blocks exit + `atexit` join (the analog of TS `unref()` + shutdown drain). `sync_mode` bypasses the thread (inline). Rejected: an asyncio consumer — forces an event loop onto sync callers, contradicts the locked sync posture.
- **Locked defaults** (TS `E7-S3`, `posthog-core-stateless.ts:268-271`): `flush_at=20`, `flush_interval=10s`, `max_batch_size=100`, `max_queue_size=1000`; size+interval earlier-of trigger; `max_batch_size` slices per-delivery. Python idiom: seconds (not ms) for `flush_interval`.
- **Injected delivery seam** (TS `E7-S3` pattern): the queue→delivery hand-off is an injected callback so PY4-S3's real gzip POST slots in with zero queue reshaping and PY4-S4's `flush`/`shutdown` can force-drain. Reuse the callback-injection SHAPE, not any browser/TS code.
- **CONTRACT vs IDIOM:** contract = TS `batch-queue.ts` (defaults, size/interval trigger, drop-oldest, max_batch_size slicing); idiom = posthog-python `consumer.py` (the daemon-thread block-with-timeout drain). The drop-oldest-vs-drop-newest split is the sharpest place the two references diverge — contract wins.
- **Neutrality lesson — docstrings ship** vendor-neutral.

## Shipped

<!-- Captured by implement-epics on close. -->
