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
- Gzip the batch body (default on); set the `[WIRE]` `Content-Type: application/json` + `Content-Encoding: gzip` headers. Fall back to uncompressed JSON if gzip yields nothing.
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
- **Envelope + transport** — posthog-source-guide (2026-07-08): `{ api_key, batch, sent_at: currentISOTime() }` (`posthog-core-stateless.ts:1338-1342`), path `${host}/batch/` (`:1350`), gzip by default with `Content-Type: application/json` + `Content-Encoding: gzip` (`:1348-1359`), fall back to raw JSON if gzip null. `fetch` injectable via options, else global (`client.ts:393-395`).
- **413 halving** — posthog-source-guide (2026-07-08): 413 is EXCLUDED from auto-retry (`posthog-core-stateless.ts:1364-1368`); the catch does `maxBatchSize = max(1, floor(batch.length/2))` and re-sends without persisting the queue change (`:1381-1388`). Port de-branded.
- **Retry** — posthog-source-guide (2026-07-08): posthog's node uses a FIXED-delay retry (`retryDelay=3000ms`, `retryCount=3`, `utils/index.ts:55-76`), retryable on 408/429/≥500 + network (`posthog-core-stateless.ts:148-151`). Port a bounded retry; exponential-vs-fixed is a builder call — fixed matches the reference, keep it simple for R1. (Note: this differs from the browser's exponential-backoff+jitter retry, which is a browser-transport concern; node need not match it.)
- **No `disableGeoip` / autocapture / pageview** wire toggles — those are browser-only. Node's mapper is a plain `NeutralEvent → wire` pass-through + the `dedupeId→uuid` placement.
- `touches: [adapters]` — this is the node backend adapter's wire-mapping layer (the de-branded PostHog-compatible capture wire per REFERENCE-BACKEND.md).
- api_impact additive.

## Shipped
