import type {
  AnalyticsAdapter,
  ConsentState,
  NeutralEvent,
  NeutralFetchOptions,
  NeutralFetchResponse,
} from 'analytics-kit';
import {
  buildPropsBackend,
  createMemoryBackend,
  resolveConsentBackend,
  DEFAULT_PERSISTENCE_MODE,
  type PersistenceMode,
  type StorageBackend,
} from './storage-backends';
import { consentStoreName, storeName } from './persistence-keys';
import { ConsentStore } from './consent';
import { PersistenceStore } from './persistence-store';

const LIBRARY_ID = 'analytics-kit-browser';
const LIBRARY_VERSION = '0.0.0';

// Rapid writes are coalesced into one backend write; the in-memory props stay
// current synchronously, and pending writes flush on unload.
const SAVE_DEBOUNCE_MS = 250;

export interface BrowserAdapterOptions {
  key: string;
  persistence?: PersistenceMode;
}

export class BrowserAdapter implements AnalyticsAdapter {
  private readonly memoryBackend: StorageBackend;
  private readonly consent: ConsentStore;
  private readonly store: PersistenceStore;

  constructor(options: BrowserAdapterOptions) {
    const mode = options.persistence ?? DEFAULT_PERSISTENCE_MODE;
    // One memory backend per client, shared by the consent read and the property
    // store so a pre-store read and later writes see the same instance.
    this.memoryBackend = createMemoryBackend();

    // Read consent FIRST, from a dedicated side-effect-free backend, BEFORE the
    // cookie/domain-probing persistence exists. A non-granted decision (denied,
    // pending, or a DNT/GPC signal) yields a memory-backed store — so an
    // opted-out / default-denied / pending client writes zero cookies (and, once
    // S4 lands, no throwaway domain-probe cookie).
    this.consent = new ConsentStore(
      resolveConsentBackend(mode, this.memoryBackend),
      consentStoreName(options.key)
    );
    const effectiveMode: PersistenceMode = this.consent.get() === 'granted' ? mode : 'memory';

    const backend = buildPropsBackend(effectiveMode, this.memoryBackend);
    this.store = new PersistenceStore({
      backend,
      name: storeName(options.key),
      saveDebounceMs: SAVE_DEBOUNCE_MS,
    });
  }

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

  getConsentState(): ConsentState {
    return this.consent.get();
  }

  setConsentState(state: ConsentState): void {
    this.consent.set(state);
  }

  async fetch(url: string, options: NeutralFetchOptions): Promise<NeutralFetchResponse> {
    return fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
    });
  }

  getPersistedProperty<T>(key: string): T | undefined {
    return this.store.getProperty<T>(key);
  }

  setPersistedProperty<T>(key: string, value: T | null): void {
    if (value === null) {
      this.store.unregister(key);
    } else {
      this.store.register({ [key]: value });
    }
  }

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
