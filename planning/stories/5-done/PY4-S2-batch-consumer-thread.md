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
- The HARDENED public `flush()` / `shutdown()` — timeout-raced drain, quiesce-flag-first, mid-drain-residue catch, no-re-arm — **PY4-S4** (this story owns the internal queue + triggers + thread; S4 drives the lifecycle). **BUT (coordination — read the Technical note):** the `AnalyticsAdapter` Protocol requires `flush`/`shutdown` to exist from S1 on, and S2 starts a live daemon thread — so S2 MUST land a MINIMAL working `flush` (force-drain the buffer once) and `shutdown` (stop-signal the thread + `join`) so S2's own tests don't leak a background thread across the session. S4 hardens these; S2 must not leave them as bare `pass`.
- Any disk/durable persistence of the queue — in-memory only (ephemeral server; durability is the consumer's infra concern).
- An asyncio consumer — explicitly NOT this cycle (the sync+thread posture is locked; PY2-S4).

## Acceptance criteria

- [ ] Enqueuing `flush_at` (default 20) events triggers a flush (size trigger); with fewer buffered, a flush fires after `flush_interval` (default 10s) elapses (interval trigger, via block-with-timeout `get`).
- [ ] **Overflow drops the OLDEST event (named test — this story OWNS the pin):** at `max_queue_size` (default 1000), enqueuing past the cap evicts the OLDEST buffered event, never blocks, never force-flushes. A dedicated named test asserts the OLDEST event is the one evicted at cap — **a drop-newest implementation (bare `queue.Queue` `put(block=False)`/`except Full`) MUST fail this test.** (This is the exact cross-port contract break the refiner flagged.) The test MUST be written so drop-newest observably fails (see the concrete shape in Technical notes): use a small `max_queue_size`, fill with distinguishable events, enqueue one past the cap with the consumer NOT draining (`sync_mode=False` but the thread paused/not started, or a directly-driven consumer), then assert the FIRST-enqueued event is absent from the buffered set AND the newest is present. Inspect the buffered/queued state directly — do NOT assert on delivered events (a size/interval flush would drain everything and mask which one was evicted).
- [ ] A flush drains at most `max_batch_size` (default 100) records per delivery; a larger backlog flushes across multiple batches.
- [ ] `sync_mode=True` delivers inline (no thread started); `sync_mode=False` uses a `daemon=True` background thread joined via `atexit`; the thread never blocks process exit.
- [ ] All four defaults are config-overridable through `AnalyticsConfig`; unset uses the locked defaults.
- [ ] The queue is in-memory only — no disk/cookie persistence.
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token; `grep -ri posthog` over the new files clean (source-level).

## Technical notes

- **⚠ DROP-OLDEST — the load-bearing cross-port contract (this story OWNS the pin + test).** — from the epic Notes + the refiner flag: the TS contract (`ts/packages/node/src/batch-queue.ts:61-65` — `if (this.buffer.length >= this.maxQueueSize) { this.buffer.shift(); } this.buffer.push(item)`, i.e. **evict-oldest-before-push**) drops the OLDEST at cap. **posthog-python's `client.py:1710-1716` does `self.queue.put(msg, block=False)` + `except Full: log.warning("queue is full")` — it drops the NEWEST. That is the DE-BRANDING reference (wire/threading/naming), NOT the contract reference; its overflow idiom MUST NOT be copied.** A bare `queue.Queue` only cheaply supports drop-newest (`put(block=False)` raises `Full`, you drop the new event) — so this is a REAL trap. Implement a manual bound: `collections.deque(maxlen=max_queue_size)` (auto-evicts oldest on append) under a `threading.Lock`, or an explicit evict-oldest-before-put. **Concrete named test shape:** with a small cap (e.g. `max_queue_size=3`) and the consumer NOT draining, enqueue events tagged `e0,e1,e2` (fills the buffer), then enqueue `e3`; assert `e0` (the OLDEST) is absent from the buffered set and `e3` (the NEWEST) is present — reading the buffered state directly, not delivered events. A drop-newest impl keeps `e0` and drops `e3`, so it fails this exact assertion. This is the cross-port break the refiner named.
- **Consumer thread model** — architect (2026-07-09, Cluster 2, high): `queue.Queue` fed by `capture`, drained by a background daemon `Thread` (block-with-timeout `get`, flush on size OR interval — same trigger as TS `batch-queue.ts`). DE-BRAND the thread/loop idiom FROM `posthog-python/posthog/consumer.py` (its `Consumer(Thread)` block-with-timeout drain) — but the OVERFLOW policy is the TS contract (drop-oldest), NOT posthog-python's. `daemon=True` so it never blocks exit + `atexit` join (the analog of TS `unref()` + shutdown drain). `sync_mode` bypasses the thread (inline). Rejected: an asyncio consumer — forces an event loop onto sync callers, contradicts the locked sync posture.
- **Locked defaults** (TS `E7-S3`, `posthog-core-stateless.ts:268-271`): `flush_at=20`, `flush_interval=10s`, `max_batch_size=100`, `max_queue_size=1000`; size+interval earlier-of trigger; `max_batch_size` slices per-delivery. Python idiom: seconds (not ms) for `flush_interval`.
- **`max_queue_size` floors at `flush_at`** (TS `batch-queue.ts:58` — `Math.max(maxQueueSize, flushAt)`): a cap below the flush threshold would drop-oldest before the size trigger could ever fire, wedging into a never-size-flush state. Clamp `max_queue_size = max(config value, flush_at)` at construction. Likewise floor `flush_at` and `max_batch_size` at 1 (TS `batch-queue.ts:50,55`) so a misconfigured `0` can't wedge the queue.
- **⚠ Test determinism — favor `sync_mode` / a directly-driven consumer over the live thread + sleeps.** A background daemon thread + wall-clock timing is a flake risk. The size-trigger, drop-oldest, and `max_batch_size`-slicing tests should drive the consumer's drain step DIRECTLY (call the drain/`next`-batch method under test) or run in `sync_mode`, asserting on the buffered/delivered state — NOT `time.sleep()` waiting for the daemon to tick. Reserve one focused test for the actual thread lifecycle (`daemon=True`, `atexit`-join, never-blocks-exit); keep it small and deterministic (e.g. a bounded `join(timeout=...)` assertion, an injected short interval), not a timing race. The interval-trigger AC can use an injected clock or a very short `flush_interval` with a bounded wait, not an open-ended sleep.
- **Injected delivery seam** (TS `E7-S3` pattern): the queue→delivery hand-off is an injected callback so PY4-S3's real gzip POST slots in with zero queue reshaping and PY4-S4's `flush`/`shutdown` can force-drain. Reuse the callback-injection SHAPE, not any browser/TS code. Until S3 lands, wire a stub delivery callback (records batches, no network) so the queue/thread/triggers are testable in isolation.
- **⚠ S2↔S4 lifecycle hand-off (thread hygiene).** The adapter's `flush`/`shutdown` are shipped Protocol members (exist from S1); S2 starts the daemon thread, so S2 owns a MINIMAL `flush` (drain the buffer once, block until the stub delivery returns) and `shutdown` (signal the consumer to stop — a `running=False`-style flag, cf. posthog-python `consumer.py:90-92` — then `thread.join()`), enough that S2's tests don't leak a live daemon thread across the session (a real pytest hygiene issue: an un-joined daemon + `atexit` join can hang or flake the run). Leave the HARDENING (configurable `shutdown_timeout`, quiesce-flag-set-FIRST-so-captures-go-inert, mid-drain-residue re-catch, resolve-on-timeout, no-re-arm) to PY4-S4 — but do NOT ship S2 with `flush`/`shutdown` as bare `pass`, or the thread leaks. The **orchestrator sequencing S2 before S4** is already the topo order; this note flags that S2's minimal lifecycle is load-bearing for S2's OWN test hygiene, not deferrable wholesale to S4.
- **CONTRACT vs IDIOM:** contract = TS `batch-queue.ts` (defaults, size/interval trigger, drop-oldest, max_batch_size slicing); idiom = posthog-python `consumer.py` (the daemon-thread block-with-timeout drain). The drop-oldest-vs-drop-newest split is the sharpest place the two references diverge — contract wins.
- **Neutrality lesson — docstrings ship** vendor-neutral.

## Shipped

> Captured by `implement-epics` on 2026-07-10.

- **Files added:** `python/src/analytics_kit/server/consumer.py` (`BatchConsumer`), `tests/test_server_consumer.py` (25 cases)
- **Files changed:** `server/adapter.py` (`LifecycleSink` protocol — adapter flush/shutdown drive the sink), `server/__init__.py` (queue-backed sink injected by construction), `config.py` (+`flush_at`/`flush_interval`/`max_batch_size`/`max_queue_size`), `__init__.py`
- **New public API:** `BatchConsumer` (bounded deque buffer + daemon-thread block-with-timeout drain, size-OR-interval trigger, drop-OLDEST overflow, `max_batch_size` slicing, `sync_mode` bypass, minimal flush/shutdown); the 4 config knobs
- **Tests added:** the named drop-oldest test (the pin) + no-leak/lifecycle/sync-mode/slicing/floor/trigger tests
- **Commit:** `core-cycle` (message = story title)
- **Reviewer notes:** clean — **drop-oldest negative-controlled** (mutating the buffer to drop-newest, and reproducing the literal posthog-python `put(block=False)`/`except Full` trap, both FAIL the named test — reads buffered state so a flush can't mask it); thread hygiene clean (no leaked daemons, double-run); the single-armed interval deadline (notify shortens, never resets) handles a sub-threshold trickle correctly. **Contract honored** (`deque(maxlen)` = TS `batch-queue.ts:61-65` evict-oldest, NOT posthog-python drop-newest).
- **Cross-story seams exposed:** **S3** slots the real gzip POST into the consumer's **injected delivery callback** (a stub records batches now); the wire-mapper reads the `NeutralEvent`s the consumer batches. **S4** hardens the minimal `flush`/`shutdown` (configurable `shutdown_timeout`, quiesce-flag-first, no-re-arm) — the current minimal versions are drain-once + stop-flag+join (sufficient for S2 hygiene, explicitly deferred-hardening in docstrings). `daemon=True` + `atexit`-join present.
