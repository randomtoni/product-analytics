import type { NeutralEvent, NeutralProperties, NeutralTraits } from './neutral-event';

export type ConsentState = 'granted' | 'denied' | 'pending';

export interface NeutralFetchOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  headers: Record<string, string>;
  body?: string;
}

export interface NeutralFetchResponse {
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface RegisterOptions {
  once?: boolean;
}

export interface ResetOptions {
  resetDevice?: boolean;
}

export interface AnalyticsAdapter {
  capture(event: NeutralEvent): void;
  identify(distinctId: string, traits?: NeutralTraits, traitsOnce?: NeutralTraits): void;
  // Super-property registration: `register` overwrites; `register(props, { once })`
  // keeps the first value. `unregister` removes a single key. The stored super-props
  // are merged into every captured event downstream, trusted — the facade gated them
  // at registration, so the merge never re-gates.
  register(props: NeutralProperties, options?: RegisterOptions): void;
  unregister(key: string): void;
  // Re-anonymize: regenerate the anonymous distinct id and clear identity /
  // persistence / session, keeping the device id unless `resetDevice` re-mints it.
  // Called on logout; routed to the live adapter so it stays effective under
  // opt-out (the live adapter's own consent posture suppresses any storage write).
  reset(options?: ResetOptions): void;
  // A cheap synchronous in-memory read: the implementor loads persistence once at
  // init and caches the current distinct id — it does NOT hit storage per call.
  getDistinctId(): string;
  group(type: string, key: string, traits?: NeutralTraits): void;
  alias(previousId: string, distinctId: string): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;

  getConsentState(): ConsentState;
  setConsentState(state: ConsentState): void;

  fetch(url: string, options: NeutralFetchOptions): Promise<NeutralFetchResponse>;
  getPersistedProperty<T>(key: string): T | undefined;
  setPersistedProperty<T>(key: string, value: T | null): void;
  getLibraryId(): string;
  getLibraryVersion(): string;
  getCustomUserAgent(): string | undefined;
}
