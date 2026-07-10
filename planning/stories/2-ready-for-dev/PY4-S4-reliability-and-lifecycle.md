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
- **Fetch-failure normalization at the transport boundary** (the R1 lesson): a transport failure (connection error, timeout, DNS, a raised HTTP-client exception) is **normalized to a `NeutralResponse` status at the transport boundary** — it NEVER leaks a raw `requests`/`urllib`/vendor exception onto the neutral surface or up through `capture`/`flush`. The neutral surface sees a status, not an exception.
- **413-halving**: a `413` (payload-too-large) response halves `max_batch_size` (floor, min 1) and re-sends the SAME records at the smaller size — do NOT drop the records, do NOT count 413 as a retryable-status backoff. Per-delivery (re-slices the records in flight), not persisted to the queue config (mirrors TS `E7-S4`).
- **`flush()`**: force-drain the buffered queue immediately (bypass the size/interval trigger); block until the in-flight delivery settles (the sync drain-to-completion posture PY2-S4 locked).
- **`shutdown()`**: drain the queue (loop until empty, catching events enqueued mid-drain) within a **configurable timeout** (`shutdown_timeout` in config, sane default e.g. 30s); on timeout, settle deterministically (the process is not hung; remaining in-memory events may be unsent — documented). After `shutdown()`, the adapter is quiesced — the thread is joined/stopped, no post-shutdown re-arm.
- Config extended additively: `shutdown_timeout`, retry budget/delay knobs (sane defaults; `extra="forbid"`).
- Unkeyed ⇒ whole-stack no-op (the `NoopAdapter` from PY4-S1's factory selection — the queue is never even built); `opt_out` (the provider's instance switch, drop-and-discard, already shipped) suppresses upstream of the adapter.

### Out

- The queue / thread / drop-oldest / `sync_mode` (PY4-S2 — this story drives them via flush/shutdown).
- The wire-mapper / gzip envelope / transport POST (PY4-S3 — this story adds the failure paths around it).
- A separate null-object client — N-A (Python no-op is the seam `NoopAdapter`, PY4-S1).
- Server-side bot filtering — deferred (no server-side UA signal in scope; same as TS `E7`).

## Acceptance criteria

- [ ] A transient failure (network / no-status / `{408, 429, 5xx}`) retries within the bounded budget; a non-413 `4xx` is dropped, not retried (named tests per class).
- [ ] A transport-level failure (raised HTTP-client exception, timeout, connection error) is normalized to a `NeutralResponse` status at the transport boundary — no raw exception escapes onto the neutral surface or through `capture`/`flush`/`shutdown` (named negative-control test: a transport that raises does NOT propagate the raw exception).
- [ ] A `413` halves `max_batch_size` (min 1) and re-sends the SAME records at the smaller size without dropping them; 413 is not counted as a retry-backoff status.
- [ ] `flush()` force-drains the buffer (bypassing the trigger) and blocks until the delivery settles; on the unkeyed no-op it returns immediately.
- [ ] `shutdown()` drains within a configurable `shutdown_timeout` (sane default), re-flushes to catch mid-drain enqueues, settles deterministically on timeout (process not hung), and quiesces (thread joined, no post-shutdown re-arm); a post-shutdown `capture` is inert.
- [ ] Unkeyed ⇒ whole-stack no-op (queue never built); `opt_out` suppresses upstream (already shipped in the provider).
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token; `grep -ri posthog` over the new files clean (source-level).

## Technical notes

- **R1 hardening lessons = cross-language seam invariants (port, don't re-derive).** — from the epic Notes + HISTORY.md:
  - **Retry classification:** transient-only — network / no-status / `{408, 429, 5xx}` retry; non-413 `4xx` is permanent (dropped). TS `E7-S4` (`posthog-core-stateless.ts:148-151` retryable set) + fixed-delay retry (`retryDelay≈3s`, bounded count). posthog-python's retry idiom is the DE-BRANDING reference, the classification is the TS contract.
  - **Fetch-failure normalization at the transport boundary:** THE R1 lesson — a failed send is normalized to a status, NEVER leaks a raw HTTP/vendor exception onto the neutral surface. In TS this is the browser's fetch-failure normalization; here it's the transport wrapper catching `requests`/`urllib` exceptions and returning a `NeutralResponse` (e.g. status 0). A named negative-control test asserts a raising transport does not propagate.
  - **413-halving:** halve `max_batch_size` (min 1), re-send SAME records, per-delivery not persisted; 413 excluded from retry-backoff (TS `E7-S4`, `posthog-core-stateless.ts:1364-1388`).
- **flush/shutdown** (TS `E7-S6`, `posthog-core-stateless.ts:1512-1568`): `flush()` force-drains + blocks until settled; `shutdown(timeout)` clears the trigger, loop-drains until empty (catching mid-drain enqueues) raced against `shutdown_timeout`, settles deterministically on timeout (resolve-with-log is the sound choice for a SIGTERM handler — a raising shutdown is a footgun), quiesces (thread joined, no re-arm). Sync drain-to-completion (PY2-S4 posture). Python default 30s (the ported reference default).
- **Sync posture** (PY2-S4, locked): `flush`/`shutdown` are synchronous, block until the delegated drain returns — no coroutine, no asyncio.
- **CONTRACT reference (port TO):** `ts/packages/node/src/send-batch.ts` (retry classification, 413-halving, resolve-on-give-up) + `ts/packages/node/src/node-analytics.ts` (flush/shutdown drain loop). **DE-BRAND FROM (idiom only):** `posthog-python/posthog/{consumer,request}.py` (the drain/retry idiom). Contract wins on classification + drop-oldest; idiom informs the thread/retry mechanics.
- **Neutrality lesson — docstrings ship** vendor-neutral.

## Shipped

<!-- Captured by implement-epics on close. -->
