import type { AnalyticsAdapter, NeutralFetchResponse } from './adapter';

const NOOP_LIBRARY_ID = 'analytics-kit';
const NOOP_LIBRARY_VERSION = '0.0.0';

export class NoopAdapter implements AnalyticsAdapter {
  capture(): void {}
  identify(): void {}
  group(): void {}
  alias(): void {}

  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}

  fetch(): Promise<NeutralFetchResponse> {
    return Promise.resolve({
      status: 0,
      text: async () => '',
      json: async () => ({}),
    });
  }

  getPersistedProperty<T>(): T | undefined {
    return undefined;
  }

  setPersistedProperty(): void {}

  getLibraryId(): string {
    return NOOP_LIBRARY_ID;
  }

  getLibraryVersion(): string {
    return NOOP_LIBRARY_VERSION;
  }

  getCustomUserAgent(): string | undefined {
    return undefined;
  }
}
