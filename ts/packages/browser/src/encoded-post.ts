import type { NeutralFetchResponse } from 'analytics-kit';
import { gzipCompress, gzipSyncFallback, isGzipData } from './gzip';
import { appendCompressedQueryParams, GZIP_CONTENT_TYPE, JSON_CONTENT_TYPE } from './transport-wire';
import { hasFetch, postViaXhr, KEEPALIVE_THRESHOLD_BYTES } from './transport';
import { LIBRARY_VERSION } from './library-version';

// The shared encode + single-POST core both delivery paths ride: the capture batch
// (browser-adapter.ts) and the session-replay segment (replay-transport.ts). It owns ONLY
// the gzip-encode and one fetch/XHR POST — never a retry/queue/batching policy. Capture
// keeps its RetryQueue wrapper around this; replay stays best-effort, calling it once and
// swallowing failures. Centralizing the encode+POST here means a corruption/threshold fix
// applies to BOTH paths at once.
//
// Base-safe: it imports only the gzip/transport/wire primitives (all already in the base
// graph for capture) and never touches rrweb or the replay body, so importing it into the
// recorder shell's base graph does NOT pull rrweb into `dist/index.*`.

// A transport-ready encoded body: a JSON string (uncompressed) or gzip bytes, plus its
// [WIRE] Content-Type and whether the compression query params should ride the URL.
export interface EncodedBody {
  body: string | Uint8Array;
  contentType: string;
  compressed: boolean;
}

// Encode a JSON envelope for transport: gzip it when compression is enabled, preferring
// the native async primitive and falling back to the sync one. On ANY compression failure
// the UNCOMPRESSED JSON string is returned rather than corrupt bytes. Validation happens
// inside gzipCompress (returns null on any failure); a final isGzipData guard catches a
// native path that silently returned non-gzip bytes.
export async function encodeBody(json: string, compressionEnabled: boolean): Promise<EncodedBody> {
  if (!compressionEnabled) {
    return { body: json, contentType: JSON_CONTENT_TYPE, compressed: false };
  }
  const native = await gzipCompress(json);
  if (native !== null && isGzipData(native)) {
    return { body: native, contentType: GZIP_CONTENT_TYPE, compressed: true };
  }
  return encodeBodySync(json, compressionEnabled);
}

// Synchronous encode for the teardown/beacon path: gzip via the SYNC fflate fallback when
// compression is enabled and it yields valid gzip bytes, else the uncompressed JSON string.
// Never the async native primitive — it cannot resolve during teardown.
export function encodeBodySync(json: string, compressionEnabled: boolean): EncodedBody {
  if (!compressionEnabled) {
    return { body: json, contentType: JSON_CONTENT_TYPE, compressed: false };
  }
  const sync = gzipSyncFallback(json);
  if (isGzipData(sync)) {
    return { body: sync, contentType: GZIP_CONTENT_TYPE, compressed: true };
  }
  return { body: json, contentType: JSON_CONTENT_TYPE, compressed: false };
}

// The single adapter-internal POST: fetch preferred, XHR the fallback. A string body
// (uncompressed, or compression off) rides the neutral fetch shape; a binary (gzipped)
// body goes to the DOM fetch/XHR with the [WIRE] compression=/ver=/_= query params appended
// and keepalive set for a POST under the ~52 KB cap. Resolves the neutral response so a
// caller (capture) can read the status; a caller that ignores it (replay) does so.
//
// This is the encode-agnostic single POST — NOT the retry/queue policy. Capture wraps this
// in its RetryQueue and back-pressure read; replay calls it once and swallows failures. On
// the string fetch path it delegates to the injected `fetchImpl` so capture's neutral fetch()
// SPI (the branch its tests intercept) stays the transport for the uncompressed case;
// replay passes the global fetch.
export async function postEncoded(
  url: string,
  encoded: EncodedBody,
  fetchImpl: (url: string, options: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<NeutralFetchResponse>
): Promise<NeutralFetchResponse> {
  if (typeof encoded.body === 'string') {
    const headers = { 'Content-Type': encoded.contentType };
    const body = encoded.body;
    if (hasFetch()) {
      // Only the string (uncompressed) body crosses the injected fetch — capture's neutral
      // string-bodied fetch() SPI. The binary body never routes here; it goes to the DOM
      // fetch below, so this callback stays within the string-only SPI contract.
      return fetchImpl(url, { method: 'POST', headers, body });
    }
    // The XHR fallback is NOT unload-safe; the unload drain relies on sendBeacon, never this path.
    return postViaXhr(url, { method: 'POST', headers, body });
  }
  const compressedUrl = appendCompressedQueryParams(url, LIBRARY_VERSION);
  // Copy into a fresh ArrayBuffer so the BodyInit is a plain (non-shared) buffer.
  const buffer = encoded.body.slice().buffer as ArrayBuffer;
  const headers = { 'Content-Type': encoded.contentType };
  if (hasFetch()) {
    return fetch(compressedUrl, {
      method: 'POST',
      headers,
      body: buffer,
      // Best-effort delivery for a closing page; only ever set under the ~52 KB cap (over
      // it, fetch keepalive errors). The gzipped body is near-always well under.
      keepalive: encoded.body.byteLength < KEEPALIVE_THRESHOLD_BYTES,
    }) as unknown as Promise<NeutralFetchResponse>;
  }
  return postViaXhr(compressedUrl, { method: 'POST', headers, body: buffer });
}
