// Adapter-internal [WIRE] transport vocabulary: the Content-Type strings and the
// ingest-URL query params this backend's capture endpoint expects. All of it is
// wire-envelope detail — none of it appears on the neutral surface. A future backend
// adapter negotiating a different wire supplies its own.

// The gzipped batch body is sent as text/plain — the [WIRE] convention this backend's
// endpoint uses to accept a gzip-framed payload; the uncompressed body is JSON.
export const GZIP_CONTENT_TYPE = 'text/plain';
export const JSON_CONTENT_TYPE = 'application/json';

// The [WIRE] compression marker value the endpoint reads to know the body is gzipped.
// A wire value, NOT the neutral toggle (which is a plain boolean) — it lives only here.
const COMPRESSION_WIRE_VALUE = 'gzip-js';

// Append the [WIRE] query params that accompany a compressed batch POST:
// - compression=: marks the body as gzipped so the endpoint decompresses it.
// - ver=: the library version, for endpoint-side compatibility.
// - _=: a cache-buster timestamp.
// Applied only when a batch is actually shipped compressed; the neutral surface never
// sees these — the adapter appends them to the resolved ingest URL just before send.
export function appendCompressedQueryParams(url: string, libraryVersion: string): string {
  const separator = url.includes('?') ? '&' : '?';
  const params = new URLSearchParams({
    compression: COMPRESSION_WIRE_VALUE,
    ver: libraryVersion,
    _: Date.now().toString(),
  });
  return `${url}${separator}${params.toString()}`;
}
