export type NeutralProperties = Record<string, unknown>;

export type NeutralTraits = NeutralProperties;

export interface NeutralEvent {
  event: string;
  distinctId: string;
  properties?: NeutralProperties;
  timestamp?: Date;
  dedupeId: string;
  sessionId?: string;
}
