import type { AnalyticsAdapter, ConsentState, NeutralFetchResponse } from './adapter';

const NOOP_LIBRARY_ID = 'analytics-kit';
const NOOP_LIBRARY_VERSION = '0.0.0';

// The unkeyed / whole-stack-no-op distinct id: structurally "no real actor".
// Lives here (not the facade) so "unkeyed ⇒ anonymous" is a property of the
// null-object adapter, not facade logic.
const ANONYMOUS_DISTINCT_ID = 'anonymous';

export class NoopAdapter implements AnalyticsAdapter {
  capture(): void {}
  identify(): void {}
  register(): void {}
  unregister(): void {}
  getDistinctId(): string {
    return ANONYMOUS_DISTINCT_ID;
  }
  group(): void {}
  alias(): void {}

  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}

  getConsentState(): ConsentState {
    return 'denied';
  }

  setConsentState(): void {}

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
