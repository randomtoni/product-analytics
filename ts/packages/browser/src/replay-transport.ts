import type { NeutralFetchResponse } from '@randomtoni/analytics-kit';
import type { ReplayEvent } from './replay';
import { isGzipSupported } from './gzip';
import { appendCompressedQueryParams } from './transport-wire';
import { beaconSend } from './transport';
import { encodeBody, encodeBodySync, postEncoded } from './encoded-post';
import { LIBRARY_VERSION } from './library-version';

// The session-replay delivery path (E14-S4) — SEPARATE from the capture batch queue.
// De-branded from posthog's session-recording `$snapshot` delivery. It reuses the SHARED
// encode + single-POST core (encoded-post.ts, the same one `browser-adapter.ts` capture
// rides) but owns its OWN buffer/flush policy in the recorder and stays best-effort: this
// module builds the replay envelope, calls the shared POST once, and swallows failures —
// NO retry queue (unlike capture).
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

// The replay delivery envelope: the buffered DOM events plus the session id the segment is
// keyed to (so a segment's snapshots carry their session, stitching replay to captured
// events on the shared id). Adapter-internal — the shape never reaches the neutral surface.
interface ReplayBatchBody {
  [REPLAY_WIRE_EVENTS_KEY]: ReplayEvent[];
  [REPLAY_WIRE_SESSION_KEY]: string | undefined;
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
      // POSTs via the shared fetch/XHR path.
      if (keepalive) {
        deliverViaBeacon(url, encodeBodySync(json, compressionEnabled));
        return;
      }
      void deliverViaFetch(url, json, compressionEnabled);
    },
  };
}

// Beacon-send an already-encoded (sync) body for the teardown window. Appends the [WIRE]
// compression query params for the gzip case, mirroring the capture beacon path (beaconBatch).
function deliverViaBeacon(url: string, encoded: { body: string | Uint8Array; contentType: string }): void {
  if (typeof encoded.body === 'string') {
    beaconSend(url, encoded.body, encoded.contentType);
    return;
  }
  beaconSend(appendCompressedQueryParams(url, LIBRARY_VERSION), encoded.body, encoded.contentType);
}

// The normal (non-teardown) POST: gzip via the async native primitive when available,
// falling back to the sync one, else uncompressed JSON — all in the SHARED encodeBody. The
// SHARED postEncoded then does the fetch/XHR selection and the [WIRE] compression params.
// Replay stays best-effort: this calls the shared POST once and swallows failures (no
// retry), unlike capture's RetryQueue-wrapped call. Never throws.
async function deliverViaFetch(url: string, json: string, compressionEnabled: boolean): Promise<void> {
  try {
    const encoded = await encodeBody(json, compressionEnabled);
    // Replay ignores the response (best-effort), so the raw DOM fetch is cast to the neutral
    // response the shared POST types its string-path fetch as — capture passes its own SPI.
    await postEncoded(url, encoded, (u, o) => fetch(u, o) as unknown as Promise<NeutralFetchResponse>);
  } catch {
    // Best-effort delivery: a failed replay POST is swallowed (no retry). The next flush
    // ships the subsequent segment; a lost segment is acceptable for replay, unlike capture.
  }
}
