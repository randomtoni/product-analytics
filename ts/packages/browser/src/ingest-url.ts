// The adapter-internal wire path appended to the consumer's `ingestHost` when no
// `ingestPath` override is supplied. This is [WIRE] — it belongs to the capture
// envelope (E5-S2), not to the neutral surface, so it stays hidden in this module.
const DEFAULT_WIRE_CAPTURE_PATH = '/batch/';

// The [WIRE] path the session-replay delivery path POSTs snapshots to, appended to the
// SAME `ingestHost` capture uses (the host is shared; only the path differs — E14-S4).
// De-branded from the reference snapshot ingestion path; a plain (non-`$`) const, so it
// stays adapter-internal and out of the neutral surface.
const DEFAULT_WIRE_REPLAY_PATH = '/s/';

export interface IngestUrlOptions {
  ingestHost?: string;
  ingestPath?: string;
}

// Resolve the absolute ingest URL the transport POSTs to from the consumer's bare
// `ingestHost` origin (+ optional `ingestPath` override), appending the adapter's
// own [WIRE] capture path when the consumer does not override it. Trailing-slash
// normalization on the host and leading-slash guarantee on the path keep the join
// free of `//` and of a missing separator.
//
// De-branded from the reference request-router (region classification + the
// endpoint-for-target switch + vendor-ingestion-domain defaulting all stripped):
// an explicit host the consumer supplies, with no vendor host or region fallback.
export function resolveIngestUrl(options: IngestUrlOptions): string | undefined {
  return joinIngestUrl(options.ingestHost, options.ingestPath ?? DEFAULT_WIRE_CAPTURE_PATH);
}

// Resolve the replay-delivery URL from the SAME `ingestHost` capture uses plus the fixed
// [WIRE] replay path — the host is shared with capture, only the path differs (E14-S4).
// There is deliberately no consumer path override: the replay path is a fixed adapter
// internal (unlike the capture path's `ingestPath` escape hatch), matching the epic's
// reuse-host + fixed-replay-path decision. Returns undefined when no host is configured.
export function resolveReplayIngestUrl(ingestHost: string | undefined): string | undefined {
  return joinIngestUrl(ingestHost, DEFAULT_WIRE_REPLAY_PATH);
}

// Join a bare `ingestHost` origin to a [WIRE] path, normalizing the trailing slash on the
// host and guaranteeing a leading slash on the path so the join is free of `//` and of a
// missing separator. undefined host (or empty after trim) ⇒ no target.
function joinIngestUrl(ingestHost: string | undefined, rawPath: string): string | undefined {
  if (ingestHost === undefined) {
    return undefined;
  }
  const host = ingestHost.trim().replace(/\/+$/, '');
  if (host === '') {
    return undefined;
  }
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return `${host}${path}`;
}
