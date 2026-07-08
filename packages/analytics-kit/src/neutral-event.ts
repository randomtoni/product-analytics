export type NeutralProperties = Record<string, unknown>;

export type NeutralTraits = NeutralProperties;

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
}
