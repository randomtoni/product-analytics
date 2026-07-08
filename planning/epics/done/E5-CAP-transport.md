---
id: E5-CAP-transport
status: done
area: capture
touches: [adapters, browser]
api_impact: additive
blocked_by: [E4-ID-identity-persistence]
updated: 2026-07-08
---

# E5-CAP-transport — Browser transport & reliability

## Why

Every browser event a consumer captures has to survive flaky networks, tab closes, rate limits, and reloads before it reaches the backend — that reliability layer is the substrate the whole `capture` cycle stands on, and E6's `track`/`page`/enrichment has nowhere to deliver until it exists. The bulk of this is a minimal port/de-brand of posthog-js's request-queue / retry-queue / rate-limiter / gzip / transport code (BRIEF §4), with one flagged **new-work** item — an offline queue that survives reloads, which PostHog does *not* have. Informed by `research/ARCHITECT-RELEASE1.md` §E5 + §E-cross gap #1.

## Success criteria

- Buffered events survive a full page reload/navigation and flush on next load — the offline-queue requirement, verifiable by a reload test (this is new work, not a port).
- Retries apply to network/5xx failures only, **never 4xx**; exponential backoff with ±50% jitter and a cap is observable.
- Last/leave events are not dropped on unload — the keepalive/sendBeacon path drains both queues.
- The ingest target is entirely config-driven: pointing `ingestHost` at a first-party reverse proxy is **config only, zero library change** (bar B); no vendor hostname or region string appears anywhere in library source.
- All transport mechanics live inside the adapter; the neutral surface exposes only `ingestHost`/`ingestPath` + the per-event `dedupeId`, so a second adapter satisfies the same surface with **zero consumer change** (bar A).
- Bot/crawler traffic is suppressed at capture time; the consumer can extend the UA denylist and opt out via config.
- The per-event `dedupeId` maps to the wire's top-level `uuid` and uses the **same neutral field name** as node (E7), so client- and server-side idempotent retries agree.

## Stories

All shipped to `stories/5-done/`. Dependency graph:

```
E5-S1 (config) ─┐
E5-S8 (dedupe) ─┴─► E5-S2 (batch queue) ─┬─► E5-S3 (retry) ─┬─► E5-S6 (transport/unload)
                                         │                  └─► E5-S9 (offline persist, NEW WORK)
                                         ├─► E5-S4 (rate-limiter)
                                         └─► E5-S5 (compression)
E5-S7 (bot filter) — no code deps (gates cap() upstream of the queue)
```

Built in topo order: **S1, S8, S7 → S2 → S3, S4, S5 → S6, S9**.

- **[E5-S1](../stories/5-done/E5-S1-ingest-transport-config.md)** *(done — `dc35b1d`)* — neutral `ingestHost`/`ingestPath` config + internal URL resolver; NO region/vendor-host defaulting (`undefined`-on-no-host); the one neutral-surface touch.
- **[E5-S8](../stories/5-done/E5-S8-per-event-dedupe-id.md)** *(done — `b606a28`)* — the shared adapter-internal wire-mapper: `dedupeId` → wire top-level `uuid` (value-agnostic), NO random `$insert_id`; shared neutral name with node (E7).
- **[E5-S7](../stories/5-done/E5-S7-bot-crawler-filtering.md)** *(done — `dd8a32d`)* — de-branded 77-substring UA denylist + `navigator.webdriver`; gates `capture()` upstream of the queue; `botFilter` opt-out + `blockedUserAgents` extension.
- **[E5-S2](../stories/5-done/E5-S2-request-batch-queue.md)** *(done — `b278fcb`)* — the transport core: pure `RequestQueue<T>` (interval+size flush); `capture()` enqueues; real `flush()` POSTs the `data:[]` envelope via the SPI; wire-mapper extended with `MERGE_EVENT`/traits normalization; E4-S3 opt-out drop-not-flush hook.
- **[E5-S3](../stories/5-done/E5-S3-retry-queue-backoff.md)** *(done — `afdb346`)* — transport-free `RetryQueue<T>`: exponential backoff ±50% jitter + cap; network/5xx only, never 4xx; online/offline listeners; `snapshot()`/`drain()` seams for S9/S6.
- **[E5-S4](../stories/5-done/E5-S4-client-rate-limiter.md)** *(done — `9a32a1b`)* — token bucket (10/s, burst 100) + neutralized back-pressure via an injected `BackPressureInterpreter` (`quota_limited` confined to one `[WIRE]` module; a 2nd adapter swaps only the interpreter).
- **[E5-S5](../stories/5-done/E5-S5-compression.md)** *(done — `e3f4118`)* — gzip: native `CompressionStream('gzip')` + fflate sync fallback + output validation; neutral `compression` toggle; the compressed BINARY rides an adapter-internal `postEncoded` seam BELOW the neutral SPI (SPI not widened).
- **[E5-S6](../stories/5-done/E5-S6-transport-selection-keepalive.md)** *(done — `63df8ce`)* — transport preference fetch → XHR → sendBeacon behind the seam; keepalive for POSTs under ~52 KB; `unload()` drains BOTH queues via sendBeacon (sync gzip on the beacon path).
- **[E5-S9](../stories/5-done/E5-S9-offline-queue-persistence.md)** *(done — `b1e97aa`)* — **NEW WORK, not a port** — a persisted-queue sidecar (localStorage; IndexedDB seam open) mirroring the S3 retry queue so buffered events survive a reload + rehydrate on next load; consent-gated, size-capped, `uuid`-idempotent. **The one BRIEF §4 requirement PostHog does not satisfy.**

## Out of scope

- `track` / `page` / `pageleave`, context enrichment, autocapture, per-context profiles — all E6-CAP-capture-enrichment.
- Server-side batching/idempotency — E7-NODE-server-capture (shares the `dedupeId` → `uuid` decision from E5-S8).
- Session id assignment/expiry and cookie persistence — E4-ID-identity-persistence (E5 consumes them; it does not build them).

## Notes

- Transport is adapter-internal; the only neutral-surface touches are the config-supplied ingest host/path and the dedupe-id concept — everything else (batch envelope, `/batch/` shape, query params, `Content-Type`) stays behind the adapter. — architect (2026-07-07): §E5 neutral-seam note.
- Batching is **time-based** (port `request-queue`) plus an added size trigger for node parity; expose `flushInterval`/`flushAt`. — architect (2026-07-07): §E5.1.
- Retry policy: exponential backoff (`base * 2**n`) capped, ±50% jitter, retry **network/5xx only, never 4xx**, `navigator.onLine` + online/offline listeners, drain on unload via sendBeacon. — architect (2026-07-07): §E5.2.
- Rate-limiter is a client token bucket; the server-side back-pressure signal is **[WIRE]** (PostHog reads a `quota_limited` response body, not `Retry-After`) — the adapter interprets whatever signal its backend sends. — architect (2026-07-07): §E5.3.
- Compression: native `CompressionStream('gzip')` with fflate sync fallback + output validation; the `compression=`/`ver=`/`_=` query params and gzipped-body `Content-Type` are **[WIRE]**. — architect (2026-07-07): §E5.4.
- Transport preference **fetch → XHR → sendBeacon**; keepalive set for POSTs under the ~52 KB cap; `unload()` flushes both queues via sendBeacon so last/pageleave events aren't dropped. — architect (2026-07-07): §E5.5.
- `ingestHost`/`ingestPath` is explicit with **no** region or `i.posthog.com` defaulting — a bare host the consumer points at their first-party reverse proxy; the adapter appends its wire path. — architect (2026-07-07): §E5.9.
- The neutral `dedupeId` maps to the wire's top-level `uuid` (UUIDv7), **not** `$insert_id` (a separate legacy random property, not the dedup key). Settle the neutral field name in the seam so browser (E5) and node (E7) agree, or cross-target idempotency breaks; the de-branded port **must not emit a random `$insert_id`**. — architect (2026-07-07): §E5.7 + §E-cross.
- **Offline queue persistence is NEW WORK, not a port.** PostHog's retry queue is an in-memory array only (`retry-queue.ts:44`) and does not survive reloads; the BRIEF requires it, so E5-S9 adds a persisted-queue wrapper flushed on next load. Do not present it as a port. — architect (2026-07-07): §E5.6 + §E-cross gap #1.
- The browser core PostHog ports from is one ~4,200-line monolith that E4/E5/E6 all slice; **E4 front-loads the shared decomposition (neutral event object + property-build order) that E5 inherits** (hence `blocked_by: E4`), so the real cost is de-branding/de-coupling it into the neutral facade + adapter, not the per-feature logic. — architect (2026-07-07): §E-cross gap #3.

## Expansion path

Transport mechanics are adapter-internal, so a future backend adapter reuses the same neutral surface (`ingestHost`/`ingestPath` + `dedupeId`) unchanged — a new backend is one adapter, zero consumer change. New back-pressure signals, transports, or a stronger persisted-queue backend (IndexedDB over localStorage) slot in additively behind the adapter. A self-hosted backend MAY reuse this adapter unchanged by serving the same capture wire (the reference backend does exactly this at T1 — see `planning/REFERENCE-BACKEND.md`) or ship its own wire behind a new adapter; the seam supports both — the wire is never a neutral commitment.
