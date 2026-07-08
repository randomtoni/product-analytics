---
id: E7-S4-batch-delivery-wire
epic: E7-NODE-server-capture
status: ready-for-dev
area: node
touches: [adapters]
depends_on: [E7-S3-server-batch-queue]
api_impact: additive
---

# E7-S4-batch-delivery-wire — Batch delivery: gzip envelope, node wire-mapper, 413-halving

## Why

Turns the buffered queue into real delivery: a node-internal wire-mapper lays each `NeutralEvent` out into the server batch shape, the batch is gzipped and POSTed to a config-supplied endpoint, and a payload-too-large (413) response halves the batch and retries. This is where the `dedupeId → wire uuid` mapping and the `{api_key, batch, sent_at}` envelope live — all adapter-internal, none of it neutral.

## Scope

### In

- A node-internal wire-mapper (`packages/node/src/wire-mapper.ts` or similar): `NeutralEvent → [WIRE]` batch-message shape. Maps the neutral `dedupeId` to the wire top-level `uuid` (verbatim carry, NOT `$insert_id`); carries `distinctId → distinct_id`, `event`, `properties`, `timestamp`. De-branded, adapter-internal — no key here appears on the neutral surface.
- The batch envelope: `{ api_key, batch: [...wire messages], sent_at }` (de-branded `[WIRE]` shape), POSTed to the config-supplied endpoint (`ingestHost` + `ingestPath`, mirroring browser — no vendor host/region default). The `/batch/`-style path is adapter-internal.
- Gzip the batch body (default on) with **node's native `gzipSync` from `node:zlib`** (`import { gzipSync } from 'node:zlib'`) in node's OWN target-local `packages/node/src/gzip.ts`; set the `[WIRE]` `Content-Type: application/json` + `Content-Encoding: gzip` headers. Fall back to uncompressed raw JSON (and OMIT the `Content-Encoding` header) if gzip yields nothing. See Technical notes for why node does NOT reuse the browser gzip module.
- Transport via the injectable `fetch` (config `fetch?`, else Node 18+ global `fetch`) — a pluggable transport primitive so the consumer can inject a fetch impl / first-party proxy.
- 413 (payload-too-large) handler: halve `maxBatchSize` (floor, min 1) and retry the same records at the smaller size — do NOT drop the records, do NOT count 413 as a retryable-status backoff.
- Transient-failure retry: network error / status-0 / 5xx (and 408/429) retry per a bounded budget; a 4xx (other than 413) is a permanent rejection (dropped, not retried).

### Out

- The queue itself, defaults, overflow (E7-S3 — this story consumes the queue's send callback).
- Public `flush()` / `shutdown()` verbs + drain-on-shutdown timeout (E7-S6).
- `setTraits` / `setGroupTraits` wire mapping (E7-S5 — this story maps plain capture events; the trait-event wire shape rides E7-S5).
- Hoisting anything to the seam: node RE-IMPLEMENTS its own wire-mapper. Do NOT import or hoist the browser `wire-mapper.ts`.
- Back-pressure / rate-limiter (browser-only concern; not in the node R1 contract).

## Acceptance criteria

- [ ] Each flushed `NeutralEvent` is mapped to the wire shape with its `dedupeId` at the top-level `uuid`; a capture retried with the same caller `dedupeId` produces the same `uuid` — idempotent at the backend.
- [ ] `uuid` is the dedup key; `$insert_id` is NOT emitted (it is a separate legacy browser property, never the node dedup key).
- [ ] A batch is gzipped and POSTed as `{ api_key, batch, sent_at }` to the config-supplied endpoint (`ingestHost`+`ingestPath`); no vendor hostname/region is defaulted.
- [ ] A 413 response halves `maxBatchSize` (min 1) and re-sends the SAME records at the smaller size without dropping them.
- [ ] A transient failure (network/status-0/5xx/408/429) retries within budget; a non-413 4xx is dropped, not retried.
- [ ] The transport uses the injected `fetch` when supplied, else global `fetch`; the wire envelope, path, gzip headers, and `uuid` mapping are ALL adapter-internal — zero wire vocabulary reaches the neutral surface (bar A: provider-swap = one adapter, zero consumer change).
- [ ] All four gates green.

## Technical notes

- **Node re-implements its own wire-mapper** — architect (2026-07-08): confirmed. The seam deliberately defines NO canonical wire format (REFERENCE-BACKEND.md:34-41: "The seam does not define its own canonical wire format, by design"). The browser `wire-mapper.ts` is `packages/browser`-local and browser-saturated (pageview/pageleave name-swaps, autocapture, merge-event trait-lifting, geoip stamp, `{data:[]}` + timestamp→offset). Node's envelope is entirely different (`{api_key, batch, sent_at}`). The ONLY shared neutral contract is the `dedupeId` field name (→ `uuid`) — a one-line mapping, not a shared module. Node is REFERENCE-BACKEND.md:41's "second backend adapter maps its own shape from the same NeutralEvent".
- **`dedupeId → uuid`, NOT `$insert_id`** — architect (2026-07-07) + posthog-source-guide (2026-07-08): the caller idempotency key is the top-level `uuid` (`posthog-core-stateless.ts:1154,1163`, via `getEventUuid`). `$insert_id` is set ONLY in the browser package (`packages/browser/src/utils/event-utils.ts:344`) as a separate random property — never the node dedup key; node emits no `$insert_id`. The `uuid` mapping mirrors the browser wire-mapper's `uuid: event.dedupeId` (`packages/browser/src/wire-mapper.ts:63`) so client- and server-side retries dedupe on one agreed value.
- **Gzip primitive — node uses `node:zlib`, target-local (SETTLED)** — architect + posthog-source-guide (2026-07-08): node re-implements gzip in its OWN `packages/node/src/gzip.ts` using `gzipSync` from `node:zlib`. It does NOT reuse `packages/browser/src/gzip.ts` for three independent reasons: (1) cross-package import violates the hard isolation bar; (2) the browser's `gzipCompress` is native-*browser* `CompressionStream`/`Response`/`Blob`; (3) its sync fallback drags `fflate`, which node has no dependency on. `node:zlib` is a Node built-in (zero new dep), C-backed (faster than fflate for server payloads), and `gzipSync` returns a `Buffer` (a `Uint8Array` subclass) that drops straight onto a `fetch` body. NO seam-hoist — gzip is an adapter-internal transport mechanic, and the two targets share no gzip implementation (browser: `CompressionStream`+fflate; node: `zlib`), so a hoisted primitive would just be the union of both. **If tests assert exact compressed bytes, use `gzipSync(buf, { mtime: 0 })`** for deterministic output (mirrors the browser's `mtime:0` trick). NOTE: posthog-js's node SDK actually inherits the shared-core `CompressionStream` path (works on Node 18+), but for our de-branded node target `node:zlib` is the strictly better primitive (guaranteed-compressed, sync, no `fflate`) — we deliberately diverge from the reference here.
- **Envelope + transport** — posthog-source-guide (2026-07-08): `{ api_key, batch, sent_at: currentISOTime() }` (`posthog-core-stateless.ts:1338-1342`), path `${host}/batch/` (`:1350`), gzip by default with `Content-Type: application/json` + `Content-Encoding: gzip` (`:1348-1359`), fall back to raw JSON if gzip null. `fetch` injectable via options, else global (`client.ts:393-395`) — it returns a standard `Response`, and status is read as `res.status`. The seam's `AnalyticsAdapter.fetch(url, NeutralFetchOptions): Promise<NeutralFetchResponse>` primitive exists, but node is NOT an `AnalyticsAdapter` (shape A) — node's config `fetch?` is its own injectable transport (plain `fetch`-signature: `(url, {method,headers,body}) => Promise<{status, ...}>`), NOT the seam SPI method. Do NOT try to satisfy `NeutralFetchOptions`/`NeutralFetchResponse` here; node defines its own minimal fetch contract (it only reads `.status`).
- **413 halving** — posthog-source-guide (2026-07-08): 413 is EXCLUDED from auto-retry (`posthog-core-stateless.ts:1364-1368`); the catch does `maxBatchSize = max(1, floor(batch.length/2))` and re-sends without persisting the queue change (`:1381-1388`). Port de-branded.
- **Retry** — posthog-source-guide (2026-07-08): posthog's node uses a FIXED-delay retry (`retryDelay=3000ms`, `retryCount=3`, `utils/index.ts:55-76`), retryable on 408/429/≥500 + network (`posthog-core-stateless.ts:148-151`). Port a bounded retry; exponential-vs-fixed is a builder call — fixed matches the reference, keep it simple for R1. (Note: this differs from the browser's exponential-backoff+jitter retry, which is a browser-transport concern; node need not match it.)
- **No `disableGeoip` / autocapture / pageview** wire toggles — those are browser-only. Node's mapper is a plain `NeutralEvent → wire` pass-through + the `dedupeId→uuid` placement.
- `touches: [adapters]` — this is the node backend adapter's wire-mapping layer (the de-branded PostHog-compatible capture wire per REFERENCE-BACKEND.md).
- **Dep coordination:** the `@types/node` devDep (added in E7-S2) is what types global `fetch`, `Buffer` (from `gzipSync`'s return), and `process` here — this story assumes it is present. If S4 somehow lands before that dep is added, add it here.
- **413-halving is per-delivery, not persisted to the queue.** The halved `maxBatchSize` re-slices the CURRENT records in flight and re-sends them; posthog does NOT write the smaller `maxBatchSize` back onto the queue config (`:1381-1388` re-sends without persisting). Decide (builder call, note it): whether the halved size sticks for subsequent flushes or resets to the configured default — the reference re-sends the current batch smaller and the outer flush loop keeps the original config. Keep it simple: halve for the retry of THESE records only.
- api_impact additive.

## Shipped
- > Reviewer suggestion (2026-07-08): the outer `deliver` re-slice at `configuredMaxBatchSize` is redundant on the non-413 path (queue already slices) but load-bearing for the 413 re-slice — a one-line note so a future reader doesn't "simplify" it away and break halving.
- > Reviewer suggestion (2026-07-08, for S6/config-validation): an unset `ingestHost` yields a host-less `/batch/` path → global `fetch` throws → status 0 → retried 4× then dropped silently. Correct-by-design for R1 (no vendor host default), but a construction-time warning when `ingestHost` is absent would stop a misconfigured consumer silently dropping every batch. Out of S4 scope.
- > Reviewer note (2026-07-08): `create-analytics.ts` casts `config.fetch ?? fetch as NodeFetch` — sound (a `Response` is a read-supertype of `{status}`); the cast is the one spot the "reads only `.status`" contract is convention not type. Leave as-is.

## Shipped

> Captured by `implement-epics` on 2026-07-08. `touches: [adapters]` — the node backend adapter's wire/transport layer (de-branded PostHog-compatible capture wire per REFERENCE-BACKEND.md).

- **Files added (node):** `wire-mapper.ts` (node-OWN `mapEventToWire`: `dedupeId`→top-level `uuid` VERBATIM, NO `$insert_id`, `distinctId`→`distinct_id`, plain event/properties/timestamp — no browser toggles; `assembleBatchEnvelope` → `{api_key, batch, sent_at}`), `gzip.ts` (node-OWN `gzipSync` from `node:zlib`, `mtime:0` deterministic, returns Buffer; NOT browser `CompressionStream`/`fflate`), `send-batch.ts` (`createSendBatch`: envelope→gzip→injectable fetch→per-delivery 413-halving→fixed-delay transient retry; node's OWN minimal `NodeFetch` reads only `.status`; resolves on give-up)
- **Files changed:** `create-analytics.ts` (wires real `createSendBatch(config.fetch ?? global fetch)` into the queue's injected `send`)
- **New public API:** none — all wire (`WireEvent`/envelope/`/batch/` path/gzip headers/`uuid` mapping/`NodeFetch`/`SendBatch`) adapter-internal (bar A). Consumers inject via existing `config.fetch`.
- **Behavior:** gzip default-on + raw-JSON fallback (omits `Content-Encoding`) if gzip null; 413 halves maxBatchSize (min-1 floor, provably terminates) re-sends SAME records per-delivery (not persisted to queue); transient network/status-0/5xx/408/429 retry (fixed 3000ms × 3), non-413 4xx dropped; `ingestHost`+`ingestPath` config, no vendor host default
- **Deliberate reference divergence:** `node:zlib` over posthog's shared-core `CompressionStream` (isolation bar + no `fflate` + sync C-backed + deterministic); fixed-delay retry (matches reference) not browser's exponential+jitter
- **Tests added:** node +30 (wire-mapper 8: dedupeId→uuid verbatim + idempotent, no-`$insert_id`, browser-fields-never-leak, envelope; send-batch 22: gzip round-trip via gunzipSync, POST to ingestHost+`/batch/` + path override + no-vendor-default, 413-halving same-records + lone-record floor + not-retry-backoff, transient retry 503→503→200 + each status + give-up-resolves-drops, non-413-4xx-dropped, 3000ms fake-timer, gzip-empty→raw-fallback, injected-vs-global fetch) → 80; seam 166 unchanged
- **Commit:** `E7-S4-batch-delivery-wire — Batch delivery: gzip envelope, node wire-mapper, 413-halving` on `core-cycle`
- **Reviewer notes:** 0 critical, 3 suggestions (redundant-slice comment; ingestHost-absent warning for S6; fetch-cast note)
- **Cross-story seams exposed:** **S5** trait/group events ride this SAME `mapEventToWire`+`assembleBatchEnvelope`+`createSendBatch` path — S5 extends `WireEvent` (lift trait bags to top-level wire keys, as browser does `set_traits`/`set_traits_once`); envelope/gzip/transport/413/retry are SETTLED. **S6** force-drains the queue whose `send` is this delivery closure (`flushNow()`/`drain()` from S3); resolve-on-give-up means a drain settles cleanly even on permanent-failure batches.
