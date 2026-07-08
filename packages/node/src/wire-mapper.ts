import type { NeutralEvent, NeutralProperties } from 'analytics-kit';

// The [WIRE] shape of a single server-side captured event and its batch envelope —
// node's OWN de-branded mapping, re-implemented (the seam defines no canonical wire
// format). Node's envelope is `{ api_key, batch, sent_at }`, entirely distinct from
// the browser adapter's `{ data: [] }` + timestamp→offset shape, so this shares no
// module with the browser wire-mapper. Every key here is adapter-internal wire
// vocabulary; none of it appears on the neutral surface.
//
// - `uuid` is the top-level idempotency key: the value carried verbatim from the
//   neutral `dedupeId` (the SAME neutral field name the browser uses), so client- and
//   server-side retries dedupe on one agreed value. It is NOT `$insert_id` (a separate
//   legacy random browser-enrichment property, never the node dedup key — not emitted).
// - No pageview/pageleave/autocapture name-swaps and no geoip toggle: those are
//   browser-only enrichment concerns. Node's mapper is a plain pass-through plus the
//   `dedupeId → uuid` placement.
export interface WireEvent {
  uuid: string;
  event: string;
  distinct_id: string;
  properties?: NeutralProperties;
  timestamp?: string;
}

export interface WireBatchEnvelope {
  api_key: string;
  batch: WireEvent[];
  sent_at: string;
}

export function mapEventToWire(event: NeutralEvent): WireEvent {
  return {
    uuid: event.dedupeId,
    event: event.event,
    distinct_id: event.distinctId,
    properties: event.properties,
    timestamp: event.timestamp?.toISOString(),
  };
}

export function assembleBatchEnvelope(
  apiKey: string,
  events: NeutralEvent[],
  now: Date
): WireBatchEnvelope {
  return {
    api_key: apiKey,
    batch: events.map(mapEventToWire),
    sent_at: now.toISOString(),
  };
}
