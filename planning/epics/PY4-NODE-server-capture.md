---
id: PY4-NODE-server-capture
status: planned
area: node
touches: [capture, adapters, privacy]
api_impact: additive
blocked_by: [PY3-CORE-taxonomy-allowlist]
updated: 2026-07-09
---

# PY4-NODE-server-capture — Python server-side capture

## Why

Server capture is the beating heart of the Python port — the server-truth events keyed on the same distinct id, the batch/consumer thread, the wire mapping, and the reliability guarantees. It is the Python realization of TS `E7-NODE-server-capture`, ported *to* `ts/packages/node/src/{node-analytics,batch-queue,send-batch,wire-mapper}.ts` and de-branded from `posthog-python` (`client.py`, `consumer.py`, `request.py`). Informed by the architect consult (2026-07-09), Clusters 1 + 2.

## Success criteria

- The client exposes the server surface (BRIEF §6): `capture(distinct_id, event, properties=None, *, dedupe_id=None)`, `set(distinct_id, traits, once=False)`, `set_group_traits(group_type, group_key, traits)`, `flush()`, `shutdown()` — keyed on the **same distinct id** the browser uses, so client + server events stitch.
- Capture routes through the **same** allowlist guard + taxonomy typing from PY3 (bar A: one privacy contract, identical for every adapter); an off-list prop/trait key **fails loudly on the server** — nothing off-list leaves.
- **Batch/consumer = a `queue.Queue` fed by `capture()` + a background daemon `Thread` draining it**, flushing on `flush_at` OR `flush_interval` (the same size-OR-interval trigger as TS `batch-queue.ts`), **drop-oldest at a bounded queue cap**, `atexit`-joined, non-blocking on process exit (`daemon=True`). A `sync_mode` flag bypasses the thread (inline POST) for tests/short scripts.
- **Idempotency: a caller-suppliable neutral `dedupe_id` maps adapter-internally to the wire top-level `uuid`** (NOT `$insert_id`); a retried `capture` with the same `dedupe_id` is idempotent; the neutral field name is the **same `dedupe_id`** the seam settles (PY2) so cross-target idempotency holds.
- The wire mapper is **adapter-internal**: the `{api_key, batch, sent_at}` gzipped envelope, the `$set`/`$group` wire keys, and any vendor host are confined to `_WIRE_*` constants — never on the neutral surface. `set`/`set_group_traits` map to person/group property updates nested in `properties` (the TS-node shape, not the browser top-level lift).
- Reliability carries the R1 seam lessons cross-language: **retry classification** (network/5xx transient only, not 4xx), **fetch-failure normalization at the transport boundary** (a failed send is normalized, never leaks a raw vendor/HTTP exception onto the neutral surface), 413-halving of the batch, and `shutdown()` drains-with-configurable-timeout then quiesces (no post-shutdown re-arm).
- Unkeyed ⇒ a **whole-stack silent no-op** (queue never sends); `opt_out` (PY2's instance-level switch, drop-and-discard) suppresses sends.

## Stories

_Tentative slice (story files not yet written):_

- **S1** — the `capture` / `set` / `set_group_traits` surface over the PY2 seam: neutral event minting (dedupe_id fallback via `uuid`), allowlist-gated, taxonomy-typed; distinct_id required.
- **S2** — the batch/consumer: bounded `queue.Queue` + background daemon `Thread`, size-OR-interval flush, drop-oldest, `atexit` join, `sync_mode` inline bypass.
- **S3** — the adapter-internal wire mapper + transport: `{api_key, batch, sent_at}` gzip envelope, `dedupe_id`→wire `uuid`, `$set`/`$group` nested wire shape, config-supplied endpoint via an injectable HTTP send.
- **S4** — reliability: retry classification (transient-only), fetch-failure normalization at the boundary, 413-halving, `flush()` force-drain + `shutdown()` timeout-drain + quiesce; the unkeyed whole-stack no-op + opt-out suppression.

## Out of scope

- Browser transport / persistence / autocapture / pageviews / offline queue / sendBeacon — **N-A-by-platform** (server has no browser), documented in the PY8 matrix, never implemented.
- The anon→identified **merge** — browser-only; server `set` is a person-props update, not a merge.
- The query client (PY5) — a separate server surface with its own auth + endpoint.
- Server-side feature-flag eval — the `feature-flags` cycle (UPCOMING), a typed extension point only here.
- Server-side bot filtering — as in TS `E7` Notes: no server-side UA signal in scope; deferred.

## Notes

- **Ported base + contract.** — architect (2026-07-09): de-brand posthog-python `client.py`/`consumer.py`/`request.py`; port *to* the TS-node contract (`node-analytics.ts`). Public `capture(distinct_id, event, props)` is the neutral signature; map it to the object envelope INSIDE the adapter — don't re-plumb internals with positional args (the TS-E7 rule).
- **Consumer thread model.** — architect (2026-07-09, Cluster 2, high): `queue.Queue` + daemon `Thread` (`consumer.py` block-with-timeout `get`, flush on size OR interval — same trigger as TS `batch-queue.ts`). daemon so it never blocks exit + `atexit` join (the analog of TS `unref()` + shutdown drain). **Match TS on overflow: bounded queue, drop-oldest**, so overflow behavior is identical across ports. `sync_mode` bypasses the thread (inline POST). Rejected: an asyncio consumer — forces an event loop onto sync callers and contradicts the sync-client ruling.
- **Idempotency key.** Neutral `dedupe_id` → wire top-level `uuid`, NOT `$insert_id`; same neutral field name as the seam settles (PY2), so cross-target idempotency holds. Carried from the TS-E7 seam decision.
- **Wire vocabulary confined.** No vendor endpoints/hostnames (consumer supplies the endpoint); `$`-keys, the `{api_key, batch, sent_at}` envelope, and gzip content-type live in `_WIRE_*` constants (the PY8 neutrality scan asserts confinement). The transport is a pluggable HTTP send so the consumer can inject a client / first-party proxy.
- **R1 hardening lessons carried (seam semantics, not TS accidents).** — PM (2026-07-09), from HISTORY.md: retry classification (transient-only), fetch-failure normalization at the transport boundary (no raw vendor/HTTP exception on the neutral surface), `dedupe_id`→wire `uuid` idempotency, reserved-internal-key discipline. These are cross-language seam invariants — port them, don't re-derive them.

## Expansion path

A second server backend (self-hosted / non-vendor) maps the same neutral verbs to its own wire — one new adapter, zero consumer change (bar A). Server-side flag evaluation drops in later behind the feature-flag extension point, additively. An async client is additive alongside the sync one.
