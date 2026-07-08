---
id: E5-S2-request-batch-queue
epic: E5-CAP-transport
status: ready-for-dev
area: capture
touches: [browser, adapters]
depends_on: [E5-S1-ingest-transport-config, E5-S8-per-event-dedupe-id]
api_impact: additive
---

# E5-S2-request-batch-queue — Time-based batch queue + wire-mapper + real delivery

## Why

The transport core: this is where `BrowserAdapter.capture()` stops dropping the enriched event and starts buffering it into a time-flushed batch that actually POSTs to the ingest URL. Every other transport slice (retry, rate-limit, compression, beacon, offline) wraps this queue.

## Scope

### In

- Port `posthog-js/packages/browser/src/request-queue.ts` (de-branded) into the browser package: a paused-at-start, time-based batch queue that groups buffered events and flushes on an interval.
- Add a **size trigger** alongside the time trigger for parity with node (E7): flush when either `flushInterval` elapses or `flushAt` events are buffered.
- Expose `flushInterval` and `flushAt` on `AnalyticsConfig` (neutral, both optional with sane defaults), threaded through `resolveAdapter` → `BrowserAdapterOptions`. **Extend the `AnalyticsConfig` shape-pin literal** (`create-analytics.test.ts:167-182`) with both fields in the same change, and thread them into the explicit `resolveAdapter` construction (it does not spread `config`) — see the S1 shape-pin note.
- Wire `BrowserAdapter.capture()` to enqueue the post-pipeline enriched event (the output of `runCapturePipeline`) into the queue instead of dropping it. Real `flush()` drains the queue and POSTs to the S1-resolved ingest URL via the SPI `fetch()`.
- The adapter-internal **wire-mapper** (shared with E5-S8, ONE module): map a `NeutralEvent` into its `[WIRE]` batch shape — the `data:[]` array envelope, `dedupeId → uuid`, and the `MERGE_EVENT`/`set_traits`/`set_traits_once`/`anonymous_distinct_id` normalization. The per-event `timestamp → offset` rewrite is `[WIRE]`. Build this in the SAME change/module S8 introduces so `dedupeId → uuid` and the merge/traits normalization are not two divergent mappers (S8 and S2 are both `depends_on` roots into S2 — whichever lands first creates the module; the other extends it).
- Hook the queue's real buffer to the **E4-S3 consent contract**: `optOut()` drops (does NOT flush) any buffered events. Wire the drop into `setConsentState('denied')` on the adapter.

### Out

- Retry / backoff on failed POSTs — E5-S3 (this story's `flush()` fires the POST; S3 wraps failures).
- Client rate-limiting / back-pressure — E5-S4.
- gzip compression of the body — E5-S5 (S2 POSTs uncompressed JSON; S5 adds the toggle).
- Transport selection (XHR/sendBeacon) + unload flush — E5-S6 (S2 uses the SPI `fetch()` directly).
- Offline persistence across reloads — E5-S9.

## Acceptance criteria

- [ ] `BrowserAdapter.capture()` enqueues the enriched (post-`runCapturePipeline`) event; it is no longer dropped.
- [ ] The queue flushes on the earlier of `flushInterval` elapsing or `flushAt` events buffered; both are config-driven with defaults (port PostHog's `DEFAULT_FLUSH_INTERVAL_MS = 3000` clamped [250, 5000] for the interval).
- [ ] `flush()` POSTs the batched `data:[]` envelope to the S1-resolved ingest URL via the SPI `fetch()`; verified against a mock adapter/fetch (never a real backend).
- [ ] The wire-mapper places `dedupeId` at top-level `uuid` (E5-S8) and normalizes the `MERGE_EVENT` / `set_traits` / `set_traits_once` / `anonymous_distinct_id` `[WIRE]` keys — keyed off `MERGE_EVENT`, not a consumer string.
- [ ] `optOut()` drops the unsent buffer without flushing (E4-S3 contract); a test asserts no POST fires after opt-out.
- [ ] The batch envelope, `data:[]` shape, and `timestamp → offset` rewrite stay adapter-internal — no wire shape leaks onto the neutral surface (bar A).

## Technical notes

- **Batching is time-based + an added size trigger.** PostHog's browser batching is purely time-based: `DEFAULT_FLUSH_INTERVAL_MS = 3000`, clamped [250, 5000] (`posthog-js/packages/browser/src/request-queue.ts:7`, clamp `:18-24`); events grouped by `batchKey || url` into a `data:[]` array (`:93-108`); starts paused (`:11`). Port the time-based flush and **add a size trigger** (`flushAt`) for parity with node (core adds `flushAt=20` + `maxBatchSize=100`, see E7). Expose `flushInterval`/`flushAt` in config. The per-event `timestamp → offset` rewrite (`:60-77`) is `[WIRE]`. — architect (2026-07-07): §E5.1.
- **Shared wire-mapper (with E5-S8).** Build ONE adapter-internal wire-mapper. It keys off `MERGE_EVENT = 'identify'` (adapter-emitted per E4-S6, not a consumer string) and the `[WIRE]` keys in `packages/browser/src/persistence-keys.ts` (`SET_TRAITS_KEY`, `SET_TRAITS_ONCE_KEY`, `ANONYMOUS_DISTINCT_ID_KEY`). Coordinate with S8 so `dedupeId → uuid` and the merge/traits normalization live in the same module. — architect (2026-07-07): §E5.1/§E5.7; E4-S6 forward note.
- **Consent buffer hook — exact wiring.** E4-S3 shipped `optOut()` = drop-not-flush the buffer, but the real buffer did not exist yet. The facade's `optOut()` (`analytics-provider.ts:132-139`) calls `liveAdapter.setConsentState('denied')` and then swaps the active delegate to the no-op. So the drop MUST land inside `BrowserAdapter.setConsentState(state)` (`browser-adapter.ts:256-258`, today just `this.consent.set(state)`): when `state === 'denied'`, drop (do NOT flush) the buffered queue, THEN set consent. Guard the E4 regression: `setConsentState('granted')` (optIn) must NOT drop, and the existing consent tests (`consent.test.ts`, `create-analytics.test.ts`) plus the E4-S3 durable-consent behavior must stay green — the buffer-drop is additive to the existing `this.consent.set(state)` call, not a replacement. — E4-S3 contract.
- **Delivery uses the neutral SPI.** POST via the adapter's own `fetch(url, NeutralFetchOptions): Promise<NeutralFetchResponse>` (E2, `adapter.ts:50`) — the neutral transport primitive. S6 later swaps in XHR/sendBeacon behind this seam.
- **`NeutralFetchResponse` needs NO extension for S2/S4 (forward-note resolved).** The current `NeutralFetchResponse` (`status` + `text()`/`json()`, `adapter.ts:11-15`) is already sufficient. S4's back-pressure signal is **body-borne**, not header-borne: PostHog reads `quota_limited: string[]` off the response **body** via `JSON.parse(httpResponse.text)` (`rate-limiter.ts:95-108`), which the existing `text()`/`json()` accessors already expose. Do NOT add a header accessor — the earlier "may need a DOM-free header extension" hedge was a false lead and is struck. — story-refiner (architect-confirmed, 2026-07-08).
- **Request body stays `string` on the neutral seam.** S2 POSTs an uncompressed JSON string via `NeutralFetchOptions.body?: string` (`adapter.ts:5-9`) — no change to the SPI. Binary bodies (gzip in S5, sendBeacon `Blob` in S6) are handled **below** the neutral SPI, inside the adapter's transport layer; the neutral `body` type does not widen in any E5 story (see S5/S6 notes). — story-refiner (architect-confirmed, 2026-07-08).
- Reference: `posthog-js/packages/browser/src/request-queue.ts` + the POST assembly in `request.ts`.

## Shipped
