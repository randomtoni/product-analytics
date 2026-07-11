import type { NeutralEvent } from '@randomtoni/analytics-kit';
import type { NodeAnalyticsConfig } from './config';
import { gzip } from './gzip';
import { joinHostPath } from './ingest-url';
import { assembleBatchEnvelope } from './wire-mapper';

// The real gzipped-wire delivery that fills the queue's `send` seam. It owns the wire
// envelope, the endpoint, gzip, transport, the 413-halving, and the transient retry —
// all adapter-internal. The queue owns WHEN/HOW-MUCH to flush; this owns HOW a batch
// leaves. `sendBatch` resolves on give-up (never rejects out to the queue, whose
// auto-flush swallows rejections anyway) so a permanent failure is a clean drop.

// Node's OWN minimal fetch contract — a plain `fetch`-signature transport that reads
// ONLY `.status`. Deliberately NOT the seam's `AnalyticsAdapter.fetch` /
// `NeutralFetchOptions` / `NeutralFetchResponse`: node is a standalone client, not an
// `AnalyticsAdapter`. The consumer's global/injected `fetch` satisfies this structurally.
export type NodeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string | Uint8Array }
) => Promise<{ status: number }>;

// Fixed-delay retry budget — mirrors the reference (retryCount=3 → 4 total attempts,
// retryDelay=3000ms). Fixed (not exponential) is the reference posture and the simplest
// correct thing for R1; the browser's exponential+jitter retry is a browser-transport
// concern node need not match.
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 3000;
const DEFAULT_MAX_BATCH_SIZE = 100;

const STATUS_PAYLOAD_TOO_LARGE = 413;

// Transient = retry within budget: 408/429/any 5xx, plus a network error (surfaced here
// as status 0 from the transport wrapper). A non-413 4xx is permanent (dropped).
function isTransientStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

interface WireOutcome {
  status: number;
}

export interface SendBatchDeps {
  config: NodeAnalyticsConfig;
  fetchImpl: NodeFetch;
  // Injectable purely so the retry delay is drivable under fake timers without a real wait.
  wait?: (ms: number) => Promise<void>;
}

// Resolve the ingest endpoint from config. No vendor host/region is ever defaulted: an
// absent `ingestHost` is a misconfiguration the consumer must fix, not a silent
// fall-through to a vendor endpoint. The `/batch/`-style path is adapter-internal and
// used only when the consumer does not override `ingestPath`.
const DEFAULT_INGEST_PATH = '/batch/';

function resolveEndpoint(config: NodeAnalyticsConfig): string {
  const path = config.ingestPath ?? DEFAULT_INGEST_PATH;
  return joinHostPath(config.ingestHost ?? '', path);
}

// POST one wire envelope. Gzip by default; on a null/empty gzip result fall back to raw
// JSON and OMIT the Content-Encoding header. Reads only `.status`. A thrown transport
// (a network error) surfaces as status 0 so the retry policy treats it as transient.
async function postEnvelope(
  fetchImpl: NodeFetch,
  url: string,
  apiKey: string,
  events: NeutralEvent[]
): Promise<WireOutcome> {
  const payload = JSON.stringify(assembleBatchEnvelope(apiKey, events, new Date()));
  const compressed = gzip(payload);
  const useGzip = compressed.length > 0;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (useGzip) {
    headers['Content-Encoding'] = 'gzip';
  }

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: useGzip ? compressed : payload,
    });
    return { status: response.status };
  } catch {
    return { status: 0 };
  }
}

export function createSendBatch(deps: SendBatchDeps): (batch: NeutralEvent[]) => Promise<void> {
  const { config, fetchImpl } = deps;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const apiKey = config.key ?? '';
  const url = resolveEndpoint(config);
  const configuredMaxBatchSize = Math.max(config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE, 1);

  // Deliver `events`, re-slicing at `maxBatchSize` and shrinking that size on a 413.
  // 413-halving is PER-DELIVERY only: the smaller size re-slices THESE records in
  // flight and is never written back to the queue config. Records are never dropped on
  // a 413 — only re-sent smaller.
  async function deliver(events: NeutralEvent[]): Promise<void> {
    let maxBatchSize = configuredMaxBatchSize;
    let pending = events;

    while (pending.length > 0) {
      // Redundant on the normal path (the queue already hands us <= maxBatchSize), but
      // load-bearing after a 413 shrinks maxBatchSize — do not "simplify" it away.
      const slice = pending.slice(0, maxBatchSize);
      const outcome = await sendWithRetry(slice);

      if (outcome.status === STATUS_PAYLOAD_TOO_LARGE) {
        if (slice.length <= 1) {
          // A single record is still too large: it cannot be halved further. Drop it
          // rather than loop forever, and continue with the rest.
          pending = pending.slice(slice.length);
          continue;
        }
        maxBatchSize = Math.max(1, Math.floor(slice.length / 2));
        continue; // re-slice the SAME pending records at the smaller size
      }

      // 2xx (accepted) or a permanent non-413 4xx / exhausted-transient give-up: this
      // slice is done either way (a permanent failure is a clean drop). Advance.
      pending = pending.slice(slice.length);
    }
  }

  // Send one slice, retrying transient failures within the fixed budget. 413 is NOT
  // retried here (it is handled by the caller's halving); a non-413 4xx is permanent.
  // Resolves with the final outcome — never rejects.
  async function sendWithRetry(slice: NeutralEvent[]): Promise<WireOutcome> {
    let outcome = await postEnvelope(fetchImpl, url, apiKey, slice);

    for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
      if (outcome.status === STATUS_PAYLOAD_TOO_LARGE || !isTransientStatus(outcome.status)) {
        return outcome;
      }
      await wait(RETRY_DELAY_MS);
      outcome = await postEnvelope(fetchImpl, url, apiKey, slice);
    }
    return outcome;
  }

  return deliver;
}
