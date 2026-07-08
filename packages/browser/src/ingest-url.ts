// The adapter-internal wire path appended to the consumer's `ingestHost` when no
// `ingestPath` override is supplied. This is [WIRE] — it belongs to the capture
// envelope (E5-S2), not to the neutral surface, so it stays hidden in this module.
const DEFAULT_WIRE_CAPTURE_PATH = '/batch/';

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
  if (options.ingestHost === undefined) {
    return undefined;
  }
  const host = options.ingestHost.trim().replace(/\/+$/, '');
  const rawPath = options.ingestPath ?? DEFAULT_WIRE_CAPTURE_PATH;
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return `${host}${path}`;
}
