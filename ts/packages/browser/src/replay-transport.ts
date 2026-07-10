import type { ReplayEvent } from './replay';
import { gzipCompress, gzipSyncFallback, isGzipData, isGzipSupported } from './gzip';
import { appendCompressedQueryParams, GZIP_CONTENT_TYPE, JSON_CONTENT_TYPE } from './transport-wire';
import { beaconSend, hasFetch, postViaXhr, KEEPALIVE_THRESHOLD_BYTES } from './transport';

// The session-replay delivery path (E14-S4) — SEPARATE from the capture batch queue.
// De-branded from posthog's session-recording `$snapshot` delivery. It reuses the neutral
// gzip/transport primitives (the same ones `browser-adapter.ts` imports for capture) but
// owns its OWN buffer/flush policy in the recorder; this module is the encode + POST leaf.
//
// It is BASE-SAFE: it names `ReplayEvent` only as a type (erased at compile time) and never
// statically imports rrweb, so importing it into the recorder shell's base graph does NOT
// pull rrweb into `dist/index.*`. The rrweb body stays behind the shell's dynamic import.

// The [WIRE] key the buffered DOM events ride under in the replay delivery body, and the
// per-batch session-linkage tag. Adapter-internal wire vocabulary (de-branded from the
// reference `$snapshot_data`/`$session_id`) — a future backend speaking a different wire
// supplies its own. Never on the neutral surface.
const REPLAY_WIRE_EVENTS_KEY = 'events';
const REPLAY_WIRE_SESSION_KEY = 'session_id';
const LIBRARY_VERSION = '0.0.0';

// The replay delivery envelope: the buffered DOM events plus the session id the segment is
// keyed to (so a segment's snapshots carry their session, stitching replay to captured
// events on the shared id). Adapter-internal — the shape never reaches the neutral surface.
interface ReplayBatchBody {
  [REPLAY_WIRE_EVENTS_KEY]: ReplayEvent[];
  [REPLAY_WIRE_SESSION_KEY]: string | undefined;
}

// A transport-ready encoded body: a JSON string (uncompressed) or gzip bytes, plus its
// [WIRE] Content-Type and whether the compression query params should ride the URL.
interface EncodedReplayBatch {
  body: string | Uint8Array;
  contentType: string;
  compressed: boolean;
}

export interface ReplayDelivery {
  // POST a flushed segment (its buffered events + the session tag) to the replay ingest
  // URL. `keepalive` marks a teardown flush: it forces the best-effort `sendBeacon` path so
  // the final segment survives the closing page. Fire-and-forget — a failed replay POST is
  // swallowed (no retry queue; replay is best-effort, unlike capture).
  send(events: ReplayEvent[], sessionId: string | undefined, keepalive: boolean): void;
}

// Build the replay delivery for a resolved ingest URL. Returns a no-op sink when no URL is
// configured (an unkeyed / no-delivery client) so the recorder's flush path is uniform.
// `compression` mirrors the capture path's neutral toggle: on by default only where the gzip
// primitive can run; a consumer opt-out (false) forces the uncompressed JSON POST.
export function createReplayDelivery(url: string | undefined, compression?: boolean): ReplayDelivery {
  const compressionEnabled = compression !== false && isGzipSupported();
  return {
    send(events, sessionId, keepalive): void {
      if (url === undefined || events.length === 0) {
        return;
      }
      const body: ReplayBatchBody = {
        [REPLAY_WIRE_EVENTS_KEY]: events,
        [REPLAY_WIRE_SESSION_KEY]: sessionId,
      };
      const json = JSON.stringify(body);
      // A teardown flush cannot await the async native gzip primitive, so it encodes with
      // the SYNC fallback and beacons; a normal flush prefers the async native gzip and
      // POSTs via the fetch/XHR path.
      if (keepalive) {
        deliverViaBeacon(url, encodeReplaySync(json, compressionEnabled));
        return;
      }
      void deliverViaFetch(url, json, compressionEnabled);
    },
  };
}

// Beacon-send an already-encoded (sync) body for the teardown window. Appends the [WIRE]
// compression query params for the gzip case, mirroring the capture beacon path.
function deliverViaBeacon(url: string, encoded: EncodedReplayBatch): void {
  if (!encoded.compressed) {
    beaconSend(url, encoded.body, encoded.contentType);
    return;
  }
  beaconSend(appendCompressedQueryParams(url, LIBRARY_VERSION), encoded.body, encoded.contentType);
}

// The normal (non-teardown) POST: gzip via the async native primitive when available,
// falling back to the sync one, else uncompressed JSON. A string body rides the neutral
// fetch shape; a binary (gzipped) body goes to the DOM fetch with the [WIRE] compression
// query params and keepalive under the ~52 KB cap — mirroring the capture `postEncoded`.
// XHR is the fallback when fetch is absent. Never throws — replay is best-effort.
async function deliverViaFetch(url: string, json: string, compressionEnabled: boolean): Promise<void> {
  try {
    const encoded = await encodeReplayAsync(json, compressionEnabled);
    if (typeof encoded.body === 'string') {
      const headers = { 'Content-Type': encoded.contentType };
      const body = encoded.body;
      if (hasFetch()) {
        await fetch(url, { method: 'POST', headers, body });
        return;
      }
      await postViaXhr(url, { method: 'POST', headers, body });
      return;
    }
    const compressedUrl = appendCompressedQueryParams(url, LIBRARY_VERSION);
    const buffer = encoded.body.slice().buffer as ArrayBuffer;
    const headers = { 'Content-Type': encoded.contentType };
    if (hasFetch()) {
      await fetch(compressedUrl, {
        method: 'POST',
        headers,
        body: buffer,
        keepalive: encoded.body.byteLength < KEEPALIVE_THRESHOLD_BYTES,
      });
      return;
    }
    await postViaXhr(compressedUrl, { method: 'POST', headers, body: buffer });
  } catch {
    // Best-effort delivery: a failed replay POST is swallowed (no retry). The next flush
    // ships the subsequent segment; a lost segment is acceptable for replay, unlike capture.
  }
}

async function encodeReplayAsync(json: string, compressionEnabled: boolean): Promise<EncodedReplayBatch> {
  if (!compressionEnabled) {
    return { body: json, contentType: JSON_CONTENT_TYPE, compressed: false };
  }
  const native = await gzipCompress(json);
  if (native !== null && isGzipData(native)) {
    return { body: native, contentType: GZIP_CONTENT_TYPE, compressed: true };
  }
  return encodeReplaySync(json, compressionEnabled);
}

function encodeReplaySync(json: string, compressionEnabled: boolean): EncodedReplayBatch {
  if (!compressionEnabled) {
    return { body: json, contentType: JSON_CONTENT_TYPE, compressed: false };
  }
  const sync = gzipSyncFallback(json);
  if (isGzipData(sync)) {
    return { body: sync, contentType: GZIP_CONTENT_TYPE, compressed: true };
  }
  return { body: json, contentType: JSON_CONTENT_TYPE, compressed: false };
}
