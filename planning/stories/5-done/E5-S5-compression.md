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

- Port the compression path (de-branded): native `CompressionStream('gzip')` when available, falling back to fflate sync compression, with output validation. Two source files (see Technical notes): the native path + output validation is `posthog-js/packages/core/src/gzip.ts`; the fflate **sync fallback** lives separately in `posthog-js/packages/browser/src/request.ts` (`gzipSync`/`strToU8` from fflate) — it is NOT in `gzip.ts`.
- Toggleable via config: a neutral `compression` switch on `AnalyticsConfig` (default on where supported), threaded through `resolveAdapter` → `BrowserAdapterOptions`. When off, S2's uncompressed POST path is used unchanged. **Extend the `AnalyticsConfig` shape-pin literal** (`create-analytics.test.ts:167-182`) with `compression?: boolean` in the same change, and thread it into the explicit `resolveAdapter` construction — see the S1 shape-pin note.
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

- **Native + fflate + validation — TWO source files.** The native path (`gzipCompress`: `CompressionStream('gzip')` → `Blob`) and the output validation (`validateNativeGzip`, magic-byte + CRC32 + size checks) are in `posthog-js/packages/core/src/gzip.ts:96-162` — note `gzipCompress` returns a **`Blob | null`** (async), NOT a string, and there is **no fflate in `gzip.ts`**. The **fflate sync fallback** (`gzipSync`/`strToU8`) is in `posthog-js/packages/browser/src/request.ts` (import `:8`; used as the sync fallback around `:469` and `:498` when the async native path is unavailable/fails). Port both: native `Blob` path from `gzip.ts`, sync fflate fallback from `request.ts`. Browser picks gzip unless `disable_compression` (`posthog-core.ts:675`, default false `:299`). `[WIRE]`: the `compression=gzip-js` query param and `ver=`/`_=` params (`request.ts:391-418`), and `Content-Type: text/plain` for gzipped bodies (`request.ts:116-123`). — architect (2026-07-07): §E5.4.
- **`CompressionStream` is available under the browser tsconfig.** The browser package builds with `lib: ["ES2022","DOM"]` (`packages/browser/tsconfig.json`), so `CompressionStream`, `Response`, `TextEncoder`, `Blob`, `DataView`, and `crypto` are all typed with no `@ts-expect-error` or ambient-declaration needed. Mirror PostHog's runtime feature-detect (`'CompressionStream' in globalThis`, `gzip.ts:7-14`) for the fallback decision — the guard is runtime, not a type concern.
- Neutralize the toggle: PostHog's is `disable_compression`; the neutral config expresses it positively (`compression?: boolean`, default on where the primitive exists). No vendor value name on the neutral type.
- **Binary body stays BELOW the neutral SPI — no `NeutralFetchOptions` change (resolved).** The neutral `NeutralFetchOptions.body` stays `string` (`adapter.ts:5-9`); it does NOT widen to `ArrayBuffer`/`Blob`/`BodyInit`. A gzipped body is binary, but that binary is handled inside the adapter's transport layer (owned by **S6**), which serializes/encodes below the neutral SPI — mirroring PostHog, where compression happens inside the request path (`preEncodeAsync` → `_encodedBody` `ArrayBuffer`, `request.ts:198-214`) and never on the public call surface. So S5 produces the compressed bytes as an adapter-internal encode step; it does NOT extend the neutral seam. The earlier "extend the SPI body additively" hedge is struck. — story-refiner (architect-confirmed, 2026-07-08).
- Reference: `posthog-js/packages/core/src/gzip.ts` + `posthog-js/packages/browser/src/request.ts`.

## Shipped
- > Reviewer suggestion (2026-07-08, improvement-pass candidate): the real `validateNativeGzip` (magic-byte/CRC32/size checks) is never exercised — jsdom returns null from the native chain, so the adapter test MODELS validation failure by mocking `gzipCompress`→null. The "never corrupt bytes" guarantee rests on untested detection logic. Add a direct unit test on `validateNativeGzip` (export it for test): too-short Blob, corrupted-trailer-CRC, wrong-input-size-trailer → each throws (and `gzipCompress` swallows to null).
- > Reviewer suggestion (2026-07-08, forward note): `ver=` is hardcoded to `LIBRARY_VERSION='0.0.0'` and always appended (reference drops it for versionless endpoints — a PostHog routing nuance, correctly not ported). Note for whoever sets a real version.

## Shipped

> Captured by `implement-epics` on 2026-07-08.

- **Files added (browser):** `gzip.ts` (de-branded: `gzipCompress` native `CompressionStream`→validated `Uint8Array|null`, `validateNativeGzip` magic/CRC32/size, `gzipSyncFallback` fflate, `isGzipSupported`/`isGzipData`), `transport-wire.ts` (the ONE `[WIRE]` module: `GZIP_CONTENT_TYPE`=text/plain + `appendCompressedQueryParams` `compression=gzip-js`/`ver=`/`_=`) + tests
- **Files changed:** `browser-adapter.ts` (`encodeBatch` native→fflate→uncompressed-string chain + `postEncoded` transport seam: string→neutral `this.fetch` SPI, binary→DOM fetch below the seam; `compression` option), `analytics-kit/create-analytics.ts` (+`AnalyticsConfig.compression?`) + shape-pin, `browser/create-analytics.ts` (thread), `package.json` (+`fflate ^0.8.2`). **SPI (`adapter.ts`) UNCHANGED** — `NeutralFetchOptions.body` stays `string`.
- **New public API:** `AnalyticsConfig.compression?: boolean` (default on where `CompressionStream` supported; de-branded from `disable_compression`)
- **Tests added:** browser +16 (gzip 8: fflate round-trip/deterministic/empty, isGzipData/isGzipSupported/gzipCompress-never-throws; adapter 8: native-success, native-null→fflate, native-validation-fail→fflate, both-bad→uncompressed-string, toggle-off, native-absent→off, `[WIRE]` params+text/plain, no-neutral-vocab) + 26 delivery adapters pinned `compression:false` → 343; seam 128
- **Commit:** `E5-S5-compression — gzip request bodies (native + fflate fallback)` on `core-cycle`
- **Reviewer notes:** 0 critical, 2 suggestions (validateNativeGzip direct test; ver= hardcode); S2/S3/S4/E4 green
- **Cross-story seams exposed (S6):** `postEncoded(url, encoded: EncodedBatch)` is the SINGLE delivery point below the neutral SPI — where **S6** adds fetch→XHR→sendBeacon selection + keepalive (<~52KB) + the unload sendBeacon path. Today: string body→neutral `this.fetch`; binary body (gzip `ArrayBuffer`)→direct DOM `fetch`. `EncodedBatch` = `{body: string|Uint8Array, contentType, compressed}` carries everything S6 needs (S6's sendBeacon re-wraps the gzip bytes as a `Blob` with Content-Type). `encodeBatch`/`postEncoded` untouched by `postBatch` — S6 layers selection on top.

## Follow-up

> E5 post-close improvement pass, 2026-07-08 (commit follows). Reviewer-verified, no regression.

- **`validateNativeGzip` tested directly** — exported `@internal` (not on the public surface) + direct tests: too-short / corrupted-trailer-CRC / wrong-input-size-trailer Blobs each REJECT, and `gzipCompress` swallows a bad native result to `null`. Closes the coverage gap jsdom's null native path left (the validator's failure-detection was untested). (Addresses the S5 reviewer suggestion.)
- Skipped-with-reason: the `ver=0.0.0` hardcode is a forward note for whoever sets a real library version.
