import type { NeutralEvent, NeutralTraits } from './neutral-event';

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

export interface AnalyticsAdapter {
  capture(event: NeutralEvent): void;
  identify(distinctId: string, traits?: NeutralTraits, traitsOnce?: NeutralTraits): void;
  group(type: string, key: string, traits?: NeutralTraits): void;
  alias(previousId: string, distinctId: string): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;

  fetch(url: string, options: NeutralFetchOptions): Promise<NeutralFetchResponse>;
  getPersistedProperty<T>(key: string): T | undefined;
  setPersistedProperty<T>(key: string, value: T | null): void;
  getLibraryId(): string;
  getLibraryVersion(): string;
  getCustomUserAgent(): string | undefined;
}
