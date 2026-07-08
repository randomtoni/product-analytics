---
id: E5-S5-compression
epic: E5-CAP-transport
status: ready-for-dev
area: capture
touches: [browser, adapters]
depends_on: [E5-S2-request-batch-queue]
api_impact: additive
---

# E5-S5-compression — gzip request bodies (native + fflate fallback)

## Why

Batched event payloads compress well; gzipping the body cuts bandwidth on every flush. This adds a toggleable gzip path to the S2 POST, with a native primitive and a sync fallback so it works everywhere the library runs.

## Scope

### In

- Port `posthog-js/packages/core/src/gzip.ts` (de-branded): compress the S2 batch body with native `CompressionStream('gzip')` when available, falling back to fflate sync compression, with output validation.
- Toggleable via config: a neutral `compression` switch on `AnalyticsConfig` (default on where supported), threaded through `resolveAdapter` → `BrowserAdapterOptions`. When off, S2's uncompressed POST path is used unchanged.
- Set the gzipped-body request headers adapter-internally (`Content-Type` for gzipped bodies is `[WIRE]`).
- The `compression=`/`ver=`/`_=` query params on the ingest URL are `[WIRE]` — the adapter appends them; they never appear on the neutral surface.

### Out

- Compressing anything other than the ingest POST body (no response decompression — the backend responds small).
- fflate as a hard dependency if the port can vendor only the sync gzip path minimally — prefer the minimal port (BRIEF: port only what we need, don't gold-plate).

## Acceptance criteria

- [ ] The S2 batch body is gzipped via native `CompressionStream('gzip')` when available, else the fflate sync fallback; output validation rejects a bad compression result and falls back to the uncompressed path rather than sending corrupt bytes.
- [ ] A neutral `compression` config toggle turns it off, restoring S2's uncompressed POST; both paths unit-tested.
- [ ] The `compression=`/`ver=`/`_=` query params and gzipped-body `Content-Type` are set adapter-internally and never appear on the neutral surface (bar A) — grep-clean of neutral types.
- [ ] No vendor value (`gzip-js`, etc.) leaks onto the neutral surface — the neutral toggle is a plain boolean/enum; the wire param value is `[WIRE]`.

## Technical notes

- **Native + fflate + validation.** Port `posthog-js/packages/core/src/gzip.ts`: native `CompressionStream('gzip')` with fflate sync fallback and output validation (`gzip.ts:96-133`); browser picks gzip unless `disable_compression` (`posthog-core.ts:675`, default false `:299`). `[WIRE]`: the `compression=gzip-js` query param and `ver=`/`_=` params (`posthog-js/packages/browser/src/request.ts:391-418`), and `Content-Type: text/plain` for gzipped bodies (`request.ts:116-123`). — architect (2026-07-07): §E5.4.
- Neutralize the toggle: PostHog's is `disable_compression`; the neutral config expresses it positively (`compression?: boolean`, default on where the primitive exists). No vendor value name on the neutral type.
- Sending gzipped bytes may need a body/header shape the S2 SPI `fetch()` path already handles (`NeutralFetchOptions.body?: string` today, `adapter.ts:5-9`) — a gzipped body is binary, so coordinate: either the SPI accepts a binary body additively, or the adapter's transport layer (S6) owns binary bodies. Flag whichever extension is needed and keep it neutral.
- Reference: `posthog-js/packages/core/src/gzip.ts` + `posthog-js/packages/browser/src/request.ts`.

## Shipped
