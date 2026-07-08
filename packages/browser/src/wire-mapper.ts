import type { NeutralEvent, NeutralProperties } from 'analytics-kit';

// The [WIRE] shape of a single captured event — the object the transport POSTs
// (S2 wraps a `data:[]` array of these). Every key here is adapter-internal wire
// vocabulary; none of it appears on the neutral surface. Kept in one place so the
// wire vocabulary lives behind the adapter and a second backend adapter maps its
// own shape from the same NeutralEvent.
//
// - `uuid` is the top-level idempotency key: the value carried verbatim from the
//   neutral `dedupeId`. It is NOT `$insert_id` (a separate legacy random
//   browser-enrichment property that is not the dedup key and is never emitted
//   here). The neutral field name is `dedupeId` — the SAME name node (E7) exposes
//   for its own idempotency key — so client- and server-side retries dedupe on one
//   agreed value.
export interface WireEvent {
  event: string;
  distinct_id: string;
  properties?: NeutralProperties;
  timestamp?: string;
  uuid: string;
}

// Lay a NeutralEvent out into its [WIRE] shape. Value-agnostic on the id: it
// carries whatever `dedupeId` holds to the top-level `uuid` — it does NOT
// re-generate or re-version the id (the id is stamped once, at capture, then
// replayed unchanged across a retry, which is all dedupe requires).
//
// This is the single wire-mapper for the E5 transport: S2 extends THIS module to
// key off `MERGE_EVENT` (and the `set_traits` / `set_traits_once` /
// `anonymous_distinct_id` [WIRE] keys) and normalize the merge/traits event into
// the vendor merge shape. The pass-through mapping below is the base every event
// takes; S2's merge/traits normalization layers on top of it, not beside it.
export function mapEventToWire(event: NeutralEvent): WireEvent {
  return {
    event: event.event,
    distinct_id: event.distinctId,
    properties: event.properties,
    timestamp: event.timestamp?.toISOString(),
    uuid: event.dedupeId,
  };
}
