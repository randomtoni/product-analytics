export type NeutralProperties = Record<string, unknown>;

export type NeutralTraits = NeutralProperties;

// The per-event enrichment override a scoped `context()` view carries (E6-S8): the
// live, per-event enrichment toggles (page/device/referrer/utm) and the wire-level
// geoip flag resolved from the named context's capture profile. Adapter-internal —
// an adapter reads it in place of its instance-level enrichment for THIS event, or
// ignores it. Absent on every root capture (the adapter falls back to its own config).
// The construction-time toggles (autocapture, pageleave) are NOT here — they bind once
// at construction and resolve from the default context.
export interface EnrichmentProfile {
  page?: boolean;
  device?: boolean;
  referrer?: boolean;
  utm?: boolean;
  disableGeoip?: boolean;
}

export interface NeutralEvent {
  event: string;
  distinctId: string;
  properties?: NeutralProperties;
  timestamp?: Date;
  dedupeId: string;
  sessionId?: string;
  // Neutral page-navigation marker, present ONLY on an event minted by the facade
  // `page()` path (named or nameless) — the pipeline's pageview recognizer. The
  // event NAME is the router path/name, so this presence-only flag, not the name,
  // is what identifies a pageview. Absent on every `track()` event. No vendor token.
  isPageView?: true;
  // Adapter-internal per-event enrichment override from a scoped context view (E6-S8).
  // Present only on events minted through `context(name).track/page/group`; absent on
  // root captures. Never reaches the wire (the wire-mapper picks explicit fields, not
  // a spread) — an adapter with no enrichment machinery ignores it.
  enrichmentProfile?: EnrichmentProfile;
}
