---
id: PY4-NODE-server-capture
status: done
area: node
touches: [capture, adapters, privacy]
api_impact: additive
blocked_by: [PY3-CORE-taxonomy-allowlist]
updated: 2026-07-10
---

# PY4-NODE-server-capture — Python server-side capture

## Why

Server capture is the beating heart of the Python port — the server-truth events keyed on the same distinct id, the batch/consumer thread, the wire mapping, and the reliability guarantees. It is the Python realization of TS `E7-NODE-server-capture`, ported *to* `ts/packages/node/src/{node-analytics,batch-queue,send-batch,wire-mapper}.ts` and de-branded from `posthog-python` (`client.py`, `consumer.py`, `request.py`). Informed by the architect consult (2026-07-09), Clusters 1 + 2.

## Success criteria

- The client exposes the server surface (BRIEF §6): `capture(distinct_id, event, properties=None, *, dedupe_id=None)`, `set(distinct_id, traits, once=False)`, `set_group_traits(group_type, group_key, traits)`, `flush()`, `shutdown()` — keyed on the **same distinct id** the browser uses, so client + server events stitch.
- Capture routes through the **same** allowlist guard + taxonomy typing from PY3 (bar A: one privacy contract, identical for every adapter); an off-list prop/trait key **fails loudly on the server** — nothing off-list leaves.
- **Batch/consumer = a `queue.Queue` fed by `capture()` + a background daemon `Thread` draining it**, flushing on `flush_at` OR `flush_interval` (the same size-OR-interval trigger as TS `batch-queue.ts`), **drop-oldest at a bounded queue cap**, `atexit`-joined, non-blocking on process exit (`daemon=True`). A `sync_mode` flag bypasses the thread (inline POST) for tests/short scripts. **Overflow policy is drop-oldest to match the TS contract reference — NOT posthog-python's drop-newest idiom (see Notes); a plain `queue.Queue.put(block=False)`/`except Full` drops the NEW event and is the WRONG behavior here.**
- **Idempotency: a caller-suppliable neutral `dedupe_id` maps adapter-internally to the wire top-level `uuid`** (NOT `$insert_id`); a retried `capture` with the same `dedupe_id` is idempotent; the neutral field name is the **same `dedupe_id`** the seam settles (PY2) so cross-target idempotency holds.
- The wire mapper is **adapter-internal**: the `{api_key, batch, sent_at}` gzipped envelope, the `$set`/`$group` wire keys, and any vendor host are confined to `_WIRE_*` constants — never on the neutral surface. `set`/`set_group_traits` map to person/group property updates nested in `properties` (the TS-node shape, not the browser top-level lift).
- Reliability carries the R1 seam lessons cross-language: **retry classification** (network/5xx transient only, not 4xx), **fetch-failure normalization at the transport boundary** (a failed send is normalized, never leaks a raw vendor/HTTP exception onto the neutral surface), 413-halving of the batch, and `shutdown()` drains-with-configurable-timeout then quiesces (no post-shutdown re-arm).
- Unkeyed ⇒ a **whole-stack silent no-op** (queue never sends); `opt_out` (PY2's instance-level switch, drop-and-discard) suppresses sends.

## Stories

Chain — `S1 → S2 → S3 → S4`; topo-sortable via `depends_on`. Written to `stories/2-ready-for-dev/`. **Reconciled with the "provider already exists" reality:** PY2+PY3 already built the PROVIDER (verbs, event minting, `dedupe_id` fallback, allowlist gating, taxonomy typing) — it calls `adapter.capture(event)`. So PY4 builds the real server **ADAPTER** + the factory `config.key`→adapter selection; it does NOT re-create provider surface. The Python no-op is the already-shipped seam `NoopAdapter` (adapter-driven) — NOT a separate `NodeNoop` client like TS E7.

- **[PY4-S1](../../stories/5-done/PY4-S1-server-adapter-capture-and-selection.md)** *(done — `549bf2d`)* — the server `ServerAdapter` (capture-entry = enqueue to an injected `EventSink`; `send`/consent/library-id) + the `create_server_analytics` target-entry doing `config.key`→build+inject (unkeyed ⇒ seam `NoopAdapter`; no `NodeNoop`). Thin — the provider already mints/gates/types.
- **[PY4-S2](../../stories/5-done/PY4-S2-batch-consumer-thread.md)** *(done — `35003d5`)* — `BatchConsumer`: bounded `deque(maxlen)` + daemon `Thread` (block-with-timeout), size-OR-interval flush, **drop-OLDEST** (⚠ the cross-port pin — negative-controlled: a drop-newest impl fails the named test), `max_batch_size` slicing, `sync_mode` bypass, `daemon=True`+`atexit`.
- **[PY4-S3](../../stories/5-done/PY4-S3-wire-mapper-and-transport.md)** *(done — `f9140f2`)* — adapter-internal wire-mapper (`dedupe_id`→top-level `uuid`, NOT `$insert_id`; recognition by `internal_kind` NOT name; wire keys match TS byte-for-byte, de-branded — `set`/`set_once`/`group_type`/`group_key`/`group_set`) + `{api_key,batch,sent_at}` gzip envelope + injectable `Transport` on the constructor (gzip below the seam `send(str)`); all wire vocab `_WIRE_*`-confined.
- **[PY4-S4](../../stories/5-done/PY4-S4-reliability-and-lifecycle.md)** *(done — `2fa706c`)* — retry classification (transient `{0,408,429,5xx}`; non-413 4xx dropped; fixed delay), **fetch-failure normalization** (raising transport → status 0, negative-controlled through the async stack), 413-halving (terminates at every size), quiesce-first `shutdown()` (timeout-drain, settle-not-raise, no re-arm, zero leaked threads). R1 hardening lessons carried as verified seam invariants.

Build topo order: `PY4-S1 → PY4-S2 → PY4-S3 → PY4-S4`.

**Module map** (a new `server/` submodule under `analytics_kit`, or flat `server_adapter.py`/`consumer.py`/`wire_mapper.py` — builder's layout call; fills no PY1-skeleton file since capture lives in the new adapter, not the empty `client.py`):

- the server `AnalyticsAdapter` impl — capture-entry/enqueue + lifecycle/consent/library-id (S1)
- the batch queue + daemon-thread consumer (S2)
- the wire-mapper (`NeutralEvent`→wire, `_WIRE_*`-confined) + the adapter-owned `Transport` Protocol + default transport (S3)
- the reliability layer — retry/normalization/413/drain (S4, folded into the adapter/transport)
- `config.py` extended additively (ingest endpoint/host/path, `flush_at`/`flush_interval`/`max_batch_size`/`max_queue_size`, `shutdown_timeout`, retry knobs); `factory.py` gains the `config.key`→server-adapter wiring via the target module

## Out of scope

- Browser transport / persistence / autocapture / pageviews / offline queue / sendBeacon — **N-A-by-platform** (server has no browser), documented in the PY8 matrix, never implemented.
- The anon→identified **merge** — browser-only; server `set` is a person-props update, not a merge.
- The query client (PY5) — a separate server surface with its own auth + endpoint.
- Server-side feature-flag eval — the `feature-flags` cycle (UPCOMING), a typed extension point only here.
- Server-side bot filtering — as in TS `E7` Notes: no server-side UA signal in scope; deferred.

## Notes

- **Ported base + contract.** — architect (2026-07-09): de-brand posthog-python `client.py`/`consumer.py`/`request.py`; port *to* the TS-node contract (`node-analytics.ts`). Public `capture(distinct_id, event, props)` is the neutral signature; map it to the object envelope INSIDE the adapter — don't re-plumb internals with positional args (the TS-E7 rule).
- **Consumer thread model.** — architect (2026-07-09, Cluster 2, high): `queue.Queue` + daemon `Thread` (`consumer.py` block-with-timeout `get`, flush on size OR interval — same trigger as TS `batch-queue.ts`). daemon so it never blocks exit + `atexit` join (the analog of TS `unref()` + shutdown drain). `sync_mode` bypasses the thread (inline POST). Rejected: an asyncio consumer — forces an event loop onto sync callers and contradicts the sync-client ruling.
- **Overflow policy = drop-OLDEST, matching the TS contract reference — an EXPLICIT divergence from posthog-python.** — architect (2026-07-09 refiner re-validation, high): the port ports TO the TS contract; TS `batch-queue.ts` bounds the queue and **drops the oldest** at cap (`shift()` then `push`). posthog-python (`client.py:1711-1715`) does `queue.put(msg, block=False)` and on `queue.Full` **drops the NEW event (drop-newest)**, logging "queue is full" — that is the DE-BRANDING reference (wire/naming/threading), NOT the contract reference, and its overflow idiom must NOT be copied. A Python adapter that dropped-newest would make the two ports observably diverge on backpressure — a real cross-port contract break. Implication for the builder: a bare `queue.Queue.put(block=False)` gives drop-newest; drop-oldest needs a manual bound (e.g. `collections.deque(maxlen=…)` `popleft`, or an explicit evict-oldest before `put`). "Identical across ports" holds vs TS only; vs posthog-python it is a deliberate, documented divergence. Rejected: drop-newest (idiomatic Python) — breaks acceptance-bar parity across ports for zero contract gain.
- **Idempotency key.** Neutral `dedupe_id` → wire top-level `uuid`, NOT `$insert_id`; same neutral field name as the seam settles (PY2), so cross-target idempotency holds. Carried from the TS-E7 seam decision.
- **Wire vocabulary confined.** No vendor endpoints/hostnames (consumer supplies the endpoint); `$`-keys, the `{api_key, batch, sent_at}` envelope, and gzip content-type live in `_WIRE_*` constants (the PY8 neutrality scan asserts confinement). The transport is a pluggable HTTP send so the consumer can inject a client / first-party proxy.
- **R1 hardening lessons carried (seam semantics, not TS accidents).** — PM (2026-07-09), from HISTORY.md: retry classification (transient-only), fetch-failure normalization at the transport boundary (no raw vendor/HTTP exception on the neutral surface), `dedupe_id`→wire `uuid` idempotency, reserved-internal-key discipline. These are cross-language seam invariants — port them, don't re-derive them.

## Expansion path

A second server backend (self-hosted / non-vendor) maps the same neutral verbs to its own wire — one new adapter, zero consumer change (bar A). Server-side flag evaluation drops in later behind the feature-flag extension point, additively. An async client is additive alongside the sync one.
