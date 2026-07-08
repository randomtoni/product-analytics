import type {
  AnalyticsAdapter,
  NeutralEvent,
  NeutralFetchOptions,
  NeutralFetchResponse,
} from 'analytics-kit';

const LIBRARY_ID = 'analytics-kit-browser';
const LIBRARY_VERSION = '0.0.0';

export class BrowserAdapter implements AnalyticsAdapter {
  capture(event: NeutralEvent): void {
    // Transport (batching / flush) lands in E5; the skeleton runs the enrichment
    // pipeline so the S7 / S8 hook points exist for later slices to extend.
    this.runCapturePipeline(event);
  }

  runCapturePipeline(event: NeutralEvent): NeutralEvent {
    return this.mergeSuperProperties(this.stampSessionId(event));
  }

  private stampSessionId(event: NeutralEvent): NeutralEvent {
    // S8 (session id) replaces this pass-through with a real NeutralEvent.sessionId stamp.
    return event;
  }

  private mergeSuperProperties(event: NeutralEvent): NeutralEvent {
    // S7 (super-properties) replaces this pass-through with the registered-super-prop merge.
    return event;
  }

  identify(): void {
    // Identity resolver + anon→identified merge land in S5 / S6.
  }

  group(): void {}

  alias(): void {}

  async flush(): Promise<void> {}

  async shutdown(): Promise<void> {}

  async fetch(url: string, options: NeutralFetchOptions): Promise<NeutralFetchResponse> {
    return fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
    });
  }

  getPersistedProperty<T>(): T | undefined {
    // Persistence store (cookie | localStorage+cookie | memory) lands in S2.
    return undefined;
  }

  setPersistedProperty(): void {}

  getLibraryId(): string {
    return LIBRARY_ID;
  }

  getLibraryVersion(): string {
    return LIBRARY_VERSION;
  }

  getCustomUserAgent(): string | undefined {
    return undefined;
  }
}
