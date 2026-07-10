---
id: PY4-S4-reliability-and-lifecycle
epic: PY4-NODE-server-capture
status: ready-for-dev
area: node
touches: [adapters]
depends_on: [PY4-S3-wire-mapper-and-transport]
api_impact: additive
---

# PY4-S4-reliability-and-lifecycle — Retry classification, 413-halving, fetch-failure normalization & flush/shutdown

## Why

Closes the epic's reliability contract — the R1 hardening lessons carried cross-language as seam invariants: retry only transient failures, normalize a failed send at the transport boundary (never leak a raw exception onto the neutral surface), halve a too-large batch, and drain the queue on `flush()`/`shutdown()` within a configurable timeout then quiesce. It is the Python realization of TS `E7-S4`'s reliability half + `E7-S6` (flush/shutdown lifecycle), realized on the PY4-S2 queue + PY4-S3 transport.

## Scope

### In

- **Retry classification** (transient-only): a failed delivery retries within a bounded budget ONLY for transient failures — network error / no-status / `{408, 429, 5xx}`. A non-413 `4xx` is a PERMANENT rejection (dropped, not retried). (Fixed-delay retry matches the reference; keep it simple.)
- **Fetch-failure normalization at the transport boundary** (the R1 lesson): a transport failure (connection error, timeout, DNS, a raised HTTP-client exception) is **normalized to a status at the transport boundary** — it NEVER leaks a raw `requests`/`urllib`/vendor exception onto the neutral surface or up through `capture`/`flush`. The normalized status is **`0`** (matching TS `send-batch.ts:85-87` `catch { return { status: 0 } }`), which the retry classifier then treats as transient (`status == 0` is in the transient set below) — so a raised transport is caught, mapped to `0`, and retried within budget, not propagated. The neutral surface sees a status, not an exception.
- **413-halving**: a `413` (payload-too-large) response halves `max_batch_size` (floor, min 1) and re-sends the SAME records at the smaller size — do NOT drop the records, do NOT count 413 as a retryable-status backoff. Per-delivery (re-slices the records in flight), not persisted to the queue config (mirrors TS `E7-S4`). **Terminal case (TS `send-batch.ts:112-116`): a SINGLE record that still 413s cannot be halved further — drop THAT record and continue with the rest (do NOT loop forever). This is the one place 413 drops a record.**
- **`flush()`**: force-drain the buffered queue immediately (bypass the size/interval trigger); block until the in-flight delivery settles (the sync drain-to-completion posture PY2-S4 locked).
- **`shutdown()`**: drain the queue (loop until empty, catching events enqueued mid-drain) within a **configurable timeout** (`shutdown_timeout` in config, sane default e.g. 30s); on timeout, settle deterministically (the process is not hung; remaining in-memory events may be unsent — documented). After `shutdown()`, the adapter is quiesced — the thread is joined/stopped, no post-shutdown re-arm.
- Config extended additively (all `extra="forbid"` known fields, snake_case, Python idiom = seconds not ms): `shutdown_timeout: float = 30.0` (TS `E7-S6` default), `retry_count: int = 3` and `retry_delay: float = 3.0` (TS `send-batch.ts:25-26` `RETRY_COUNT=3` / `RETRY_DELAY_MS=3000` → fixed-delay, bounded count → 4 total attempts). No collision with S1's `ingest_host`/`ingest_path` or S2's `flush_at`/`flush_interval`/`max_batch_size`/`max_queue_size`/`sync_mode`. The retry-delay wait should be injectable (or the delay short-circuitable) so retry tests don't sleep real seconds (TS injects `wait` — `send-batch.ts:44`).
- Unkeyed ⇒ whole-stack no-op (the `NoopAdapter` from PY4-S1's factory selection — the queue is never even built); `opt_out` (the provider's instance switch, drop-and-discard, already shipped) suppresses upstream of the adapter.

### Out

- The queue / thread / drop-oldest / `sync_mode` (PY4-S2 — this story drives them via flush/shutdown).
- The wire-mapper / gzip envelope / transport POST (PY4-S3 — this story adds the failure paths around it).
- A separate null-object client — N-A (Python no-op is the seam `NoopAdapter`, PY4-S1).
- Server-side bot filtering — deferred (no server-side UA signal in scope; same as TS `E7`).

## Acceptance criteria

- [ ] A transient failure (network / no-status / `{408, 429, 5xx}`) retries within the bounded budget; a non-413 `4xx` is dropped, not retried (named tests per class).
- [ ] A transport-level failure (raised HTTP-client exception, timeout, connection error) is normalized to a `NeutralResponse` status at the transport boundary — no raw exception escapes onto the neutral surface or through `capture`/`flush`/`shutdown` (named negative-control test: a transport that raises does NOT propagate the raw exception).
- [ ] A `413` halves `max_batch_size` (min 1) and re-sends the SAME records at the smaller size without dropping them; 413 is not counted as a retry-backoff status. A SINGLE record that still 413s is dropped and the rest continue (named test — the terminal case; no infinite loop).
- [ ] `flush()` force-drains the buffer (bypassing the trigger) and blocks until the delivery settles; on the unkeyed no-op it returns immediately.
- [ ] `shutdown()` drains within a configurable `shutdown_timeout` (sane default), re-flushes to catch mid-drain enqueues, settles deterministically on timeout (process not hung), and quiesces (thread joined, no post-shutdown re-arm); a post-shutdown `capture` is inert.
- [ ] Unkeyed ⇒ whole-stack no-op (queue never built); `opt_out` suppresses upstream (already shipped in the provider).
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token; `grep -ri posthog` over the new files clean (source-level).

## Technical notes

- **R1 hardening lessons = cross-language seam invariants (port, don't re-derive).** — from the epic Notes + HISTORY.md:
  - **Retry classification:** transient-only — network / no-status(status 0) / `{408, 429, 5xx}` retry; non-413 `4xx` is permanent (dropped). TS `E7-S4` (`ts/packages/node/src/send-batch.ts:33-35` `isTransientStatus` = `status === 0 || 408 || 429 || >= 500`) + fixed-delay retry (`RETRY_COUNT=3`/`RETRY_DELAY_MS=3000`, `send-batch.ts:25-26,131-142`; 4 total attempts). posthog-python's retry idiom (`consumer.py:216-228` `is_retryable`, exponential backoff) is the DE-BRANDING reference; the classification + FIXED delay are the TS contract — do NOT port posthog-python's exponential backoff.
  - **Fetch-failure normalization at the transport boundary:** THE R1 lesson — a failed send is normalized to a status, NEVER leaks a raw HTTP/vendor exception onto the neutral surface. The ported node reference is `ts/packages/node/src/send-batch.ts:85-87` (`try { ... } catch { return { status: 0 } }`) — the transport wrapper catches `requests`/`urllib` exceptions and returns status `0`, which the retry classifier treats as transient. A named negative-control test asserts a raising transport does NOT propagate the raw exception onto the neutral surface (it surfaces as status 0, retried then given up cleanly).
  - **413-halving:** halve `max_batch_size` (min 1), re-send SAME records, per-delivery not persisted; 413 excluded from retry-backoff; a single record that still 413s is dropped (TS `E7-S4`, `ts/packages/node/src/send-batch.ts:101-126` — the `deliver` re-slice loop, 413-drop-single at `:112-116`).
- **flush/shutdown** (TS `E7-S6`, `ts/packages/node/src/node-analytics.ts:199-239` — the actual drain code): `flush()` force-drains + blocks until settled and leaves the adapter usable (does NOT quiesce). `shutdown(timeout)`: **set the `stopped`/quiesced flag FIRST** (`node-analytics.ts:214-215`) so a `capture` racing in during the drain is inert — this is the load-bearing "no new work once shutdown starts" invariant that prevents a post-shutdown enqueue from re-arming delivery; THEN loop-drain until the buffer is empty (catching residue enqueued during an in-flight delivery — `drainLoop` at `node-analytics.ts:235-239`) raced against `shutdown_timeout`; on timeout **settle deterministically (resolve-with-log, do NOT raise** — a raising shutdown in a SIGTERM handler is an unhandled-exception footgun; remaining in-memory events left unsent by design, ephemeral server, no disk persistence); a final drain/quiesce joins-or-stops the thread. Sync drain-to-completion (PY2-S4 posture). **Python realization:** signal the daemon consumer to stop (a `running=False`-style flag, cf. posthog-python `consumer.py:90-92` `pause()`), then `thread.join(timeout=shutdown_timeout)`; after join the thread is stopped and no re-arm is possible. A post-shutdown `capture` must be inert (checked by AC). Python default `shutdown_timeout=30.0s`.
- **Sync posture** (PY2-S4, locked): `flush`/`shutdown` are synchronous, block until the delegated drain returns — no coroutine, no asyncio.
- **CONTRACT reference (port TO):** `ts/packages/node/src/send-batch.ts` (retry classification, 413-halving, resolve-on-give-up) + `ts/packages/node/src/node-analytics.ts` (flush/shutdown drain loop). **DE-BRAND FROM (idiom only):** `posthog-python/posthog/{consumer,request}.py` (the drain/retry idiom). Contract wins on classification + drop-oldest; idiom informs the thread/retry mechanics.
- **Neutrality lesson — docstrings ship** vendor-neutral.

## Shipped

> Captured by `implement-epics` on 2026-07-10.

- **Files changed:** `server/transport.py` (retry classification + fetch-failure normalization + 413-halving around `create_send_batch`), `server/consumer.py` (hardened `flush`/`shutdown` — quiesce-first, timeout-raced, settle-not-raise), `config.py` (+`shutdown_timeout`/`retry_count`/`retry_delay`), `server/__init__.py`
- **Files added:** `tests/test_server_reliability.py` (fault-injecting probes)
- **New public API:** the 3 config fields (`shutdown_timeout=30.0`, `retry_count=3`, `retry_delay=3.0`); `create_send_batch(..., wait=None)` (injectable retry pause)
- **Tests added:** retry per-class, fetch-failure normalization negative-control, 413-halving + terminal drop, quiesce-first shutdown, flush-stays-usable, unkeyed no-op
- **Commit:** `core-cycle` (message = story title)
- **Reviewer notes:** clean — **normalization negative-controlled through the full async stack** (raising transport → status 0, no raw exception escapes, daemon survives), retry classification `{0,408,429,5xx}` transient / non-413 4xx dropped (fixed delay, no exponential backoff), **413-halving terminates at every size {1,2,3,7,100}** (single-record-still-413 drops only that record), quiesce-first shutdown leaks zero daemon threads (50 cycles + double run). `except Exception` (not `BaseException`) so `KeyboardInterrupt`/`SystemExit` still propagate.
> Reviewer suggestion (2026-07-10): the async-mode shutdown-TIMEOUT path (daemon orphaned finishing an in-flight POST) has no named test — the timeout-drain test uses `sync_mode`. Correct-by-design (daemon never blocks exit), a coverage gap only. Add a named test for the async orphaned-daemon timeout path. (Improvement-pass.)
- **Cross-story seams exposed:** PY4 server-capture is COMPLETE — config+selection (S1) → drop-oldest queue+daemon (S2) → wire-mapper+gzip transport (S3) → reliability+lifecycle (S4) compose into the full vendor-neutral server-capture path, R1 hardening lessons carried as empirically-verified seam invariants. PY7's example consumer exercises this; PY8's parity matrix audits it vs TS E7.

## Follow-up

> PY4 post-close improvement pass, 2026-07-10.

- **Added the async-mode shutdown-timeout coverage test** — `test_async_shutdown_join_timeout_settles_without_raising_and_leaks_no_thread`: a real daemon (`sync_mode=False`) mid-in-flight delivery when `shutdown(shutdown_timeout=0.1)` is called; asserts shutdown returns bounded, doesn't raise, quiesces, and leaks no thread once the (Event-blocked) delivery releases. Deterministic (Events, not sleeps). Test-only; no src change (behavior was already correct). The two settle branches are now both covered: residue-remains-on-drain (logs, sync-mode test) + join-times-out-on-in-flight-delivery (this one). Gates green ×2 (mypy strict 32 · ruff · pytest 254 · no leaked threads · neutrality clean).
