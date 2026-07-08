---
id: E5-S6-transport-selection-keepalive
epic: E5-CAP-transport
status: ready-for-dev
area: capture
touches: [browser, adapters]
depends_on: [E5-S2-request-batch-queue, E5-S3-retry-queue-backoff]
api_impact: additive
---

# E5-S6-transport-selection-keepalive — Transport preference + unload flush via sendBeacon

## Why

The last event before a tab closes (a pageleave, a final click) is the one most likely to be lost. This adds the fetch → XHR → sendBeacon transport preference and an unload handler that drains both the batch queue and the retry queue via sendBeacon, so leave-events aren't dropped.

## Scope

### In

- Port the transport-preference logic from `posthog-js/packages/browser/src/request.ts` (de-branded): prefer `fetch`, fall back to `XHR`, fall back to `sendBeacon`, applied behind the adapter's `fetch()` SPI seam (S2 currently calls the SPI directly; S6 makes that SPI implementation pick the right transport).
- Set `keepalive` on `fetch` POSTs under the ~52 KB size cap (`64*1024*0.8`).
- Add an `unload()` handler (pagehide/visibilitychange/beforeunload) that flushes **both** the S2 batch queue and the S3 retry queue via sendBeacon so last/pageleave events aren't dropped.
- Wire the drain entry point S3 exposed into this unload handler.

### Out

- Deciding WHICH events fire on unload (pageleave capture itself) — E6-CAP-capture-enrichment; S6 only guarantees the transport drains whatever is buffered.
- Compression of the beacon body — E5-S5 (S6 sends whatever S2/S5 produced; sendBeacon has body-type constraints — see Technical notes).
- Persisting undelivered events past the unload window — E5-S9 (S6 best-effort drains synchronously; S9 catches what beacon can't).

## Acceptance criteria

- [ ] The adapter's transport selects fetch → XHR → sendBeacon by availability; unit-tested by stubbing each primitive's presence.
- [ ] `keepalive` is set on fetch POSTs under the ~52 KB cap; a batch over the cap does not set keepalive.
- [ ] An unload event (pagehide/visibilitychange) drains BOTH the batch queue and the retry queue via sendBeacon; a test asserts buffered events are sent on simulated unload.
- [ ] Transport selection and the unload path stay adapter-internal — no transport choice leaks onto the neutral surface (bar A).

## Technical notes

- **Transport preference + keepalive + unload drain.** Port from `posthog-js/packages/browser/src/request.ts`: transport preference **fetch → XHR → sendBeacon** (`:420-455`), `keepalive` set for POSTs under ~52 KB (`64*1024*0.8`, `:29-35`), and `unload()` flushing both queues via sendBeacon (`request-queue.ts:36-49`, `retry-queue.ts:182-196`) so last/pageleave events aren't dropped. — architect (2026-07-07): §E5.5.
- **This story implements the `fetch()` SPI, not the neutral type.** The neutral SPI is `fetch(url, NeutralFetchOptions): Promise<NeutralFetchResponse>` (`adapter.ts:50`). S2 called `fetch` (global) directly in the adapter's SPI method; S6 replaces that body with the fetch → XHR → sendBeacon selection. The neutral SPI signature does not change.
- **S6 owns the binary body below the neutral SPI (resolved).** Per the architect ruling, the neutral `NeutralFetchOptions.body` stays `string` in every E5 story; binary bodies (S5's gzipped `ArrayBuffer`, sendBeacon's `Blob`) are handled inside the adapter's transport layer, which is THIS story's surface. S6's `fetch()`-SPI implementation is where the neutral `string` body is (optionally) gzip-encoded and where each transport (`fetch`/XHR/sendBeacon) consumes the right body type. No neutral-type change lands in S5 or S6. — story-refiner (architect-confirmed, 2026-07-08).
- **sendBeacon body constraint.** `navigator.sendBeacon` takes a `Blob`/`BodyInit`, not an arbitrary string with a custom `Content-Type` in all browsers — so when S5's compression is on, the beacon drain sends the compressed `Blob` (fine); when off, send the JSON string. Keep the body-type handling adapter-internal, inside this transport layer.
- **DOM primitives are typed under the browser tsconfig.** `navigator.sendBeacon`, `XMLHttpRequest`, `fetch`, `Blob`, `AbortController`, and the `pagehide`/`visibilitychange`/`beforeunload` events are all available with `lib: ["ES2022","DOM"]` (`packages/browser/tsconfig.json`) — no ambient declarations needed. Runtime feature-detect each transport's presence (the AC's "stub each primitive's presence") rather than type-guarding.
- Reference: `posthog-js/packages/browser/src/request.ts` (transport + keepalive), `request-queue.ts:36-49` + `retry-queue.ts:182-196` (unload drains).

## Shipped
- > Reviewer suggestion (2026-07-08, doc): the XHR fallback path has no keepalive equivalent (XHR has none) — inherent/acceptable since the unload drain relies on sendBeacon, not this path. Add a one-line note in `postEncoded` that the XHR branch isn't unload-safe.
- > Reviewer suggestion (2026-07-08, optional): `unload()` is public (`@internal`) so a unit test can invoke the drain; bar A not violated (`AnalyticsAdapter` has no `unload`, neutral contract unaffected). Could be made `private` via the same `as unknown as {...}` cast the suite already uses, since the DOM-dispatch tests prove the wiring.

## Shipped

> Captured by `implement-epics` on 2026-07-08.

- **Files added (browser):** `transport.ts` (adapter-internal primitives: `hasFetch`/`hasXhr`/`hasSendBeacon` runtime feature-detects, `KEEPALIVE_THRESHOLD_BYTES = 64*1024*0.8`, `postViaXhr` (neutral-response-shaped), `beaconSend` (Blob-wraps body+content-type, never throws)) + test
- **Files changed:** `browser-adapter.ts` (`postEncoded` selects fetch→XHR by availability, keepalive under cap on the binary path; constructor binds `pagehide`/`visibilitychange`/`beforeunload` defensively; `unload()` drains BOTH queues via `beaconSend` using the SYNC gzip; `shutdown()` unbinds), `request-queue.ts` (+`drain(): T[]` take-all-no-send + clearTimer)
- **New public API:** none — transport selection/keepalive/unload all adapter-internal (bar A); SPI (`adapter.ts`) UNCHANGED
- **Tests added:** browser +28 (transport: feature-detects/keepalive-threshold/postViaXhr/beaconSend string+binary+absent+throwing; request-queue drain 3; adapter S6: fetch-preferred-rides-SPI, XHR-fallback, keepalive under/over cap, unload-drains-both-queues, pagehide/visibilitychange wiring, visible-does-not-drain, idempotent latch, shutdown unbinds, compressed-unload-sync-gzip, bar-A/SPI-unchanged pins) → 371; seam 128
- **Commit:** `E5-S6-transport-selection-keepalive — Transport preference + unload flush via sendBeacon` on `core-cycle`
- **Reviewer notes:** 0 critical, 2 doc/optional suggestions; S2/S3/S4/S5/E4 green (string path preserved on `this.fetch`)
- **Cross-story seams exposed (S9):** S6's unload is **best-effort synchronous** (sendBeacon fire-and-forget + sync gzip; async `CompressionStream` can't resolve during teardown). It does NOT guarantee delivery — a beacon can be dropped, and anything captured after the latch fires is lost. **S9** durably mirrors the queues (E4 `StorageBackend` under its own store name) so undelivered events survive past the unload window + rehydrate on next load, leaning on S8's `uuid` for idempotent double-send. Seams present: `RetryQueue.snapshot()` (non-destructive) + `RequestQueue.drain()`/`RetryQueue.drain()` (take-all).
