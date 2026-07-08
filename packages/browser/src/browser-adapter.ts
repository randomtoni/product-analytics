import type {
  AnalyticsAdapter,
  ConsentState,
  NeutralEvent,
  NeutralProperties,
  NeutralTraits,
  NeutralFetchOptions,
  NeutralFetchResponse,
  RegisterOptions,
} from 'analytics-kit';
import {
  buildPropsBackend,
  createMemoryBackend,
  resolveConsentBackend,
  DEFAULT_PERSISTENCE_MODE,
  type PersistenceMode,
  type StorageBackend,
} from './storage-backends';
import {
  consentStoreName,
  storeName,
  ANONYMOUS_DISTINCT_ID_KEY,
  ANONYMOUS_IDENTITY_STATE,
  MERGE_EVENT,
  RESERVED_EVENT_KEYS,
  SET_TRAITS_KEY,
  SET_TRAITS_ONCE_KEY,
} from './persistence-keys';
import { ConsentStore } from './consent';
import { PersistenceStore } from './persistence-store';
import { IdentityStore, type IdGenerator } from './identity-store';
import { SessionIdManager } from './session-id-manager';
import { generateUuidV7 } from './uuid-v7';

const LIBRARY_ID = 'analytics-kit-browser';
const LIBRARY_VERSION = '0.0.0';

// Rapid writes are coalesced into one backend write; the in-memory props stay
// current synchronously, and pending writes flush on unload.
const SAVE_DEBOUNCE_MS = 250;

export interface BrowserAdapterOptions {
  key: string;
  persistence?: PersistenceMode;
  // Config-authoritative cross-subdomain cookie domain. When set, the identity
  // cookie is written at that domain and the public-suffix probe never runs.
  cookieDomain?: string;
  // Opt into cross-subdomain sharing; when true and `cookieDomain` is unset, the
  // public-suffix probe derives the domain (gated behind the consent-first read).
  crossSubdomainCookie?: boolean;
  // Swap the id scheme (device id) without touching identity semantics; defaults
  // to the crypto UUIDv7 generator.
  deviceIdGenerator?: IdGenerator;
  sessionIdleTimeoutMs?: number;
  sessionMaxLengthMs?: number;
}

export class BrowserAdapter implements AnalyticsAdapter {
  private readonly memoryBackend: StorageBackend;
  private readonly consent: ConsentStore;
  private readonly store: PersistenceStore;
  private readonly identity: IdentityStore;
  private readonly session: SessionIdManager;

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

    // The cookie-domain resolution (and its public-suffix probe) lives inside
    // buildPropsBackend's non-memory branches, reached only when effectiveMode is
    // NOT 'memory' — i.e. consent is granted. An opted-out / pending / DNT client
    // hits the 'memory' branch, so no throwaway probe cookie is ever written.
    const backend = buildPropsBackend(effectiveMode, this.memoryBackend, {
      cookieDomain: options.cookieDomain,
      crossSubdomainCookie: options.crossSubdomainCookie,
    });
    this.store = new PersistenceStore({
      backend,
      name: storeName(options.key),
      saveDebounceMs: SAVE_DEBOUNCE_MS,
    });

    // Mint/load the anonymous distinct id + separate device id and cache the
    // distinct id in memory, so getDistinctId() never hits storage per event.
    this.identity = new IdentityStore({
      store: this.store,
      deviceIdGenerator: options.deviceIdGenerator,
    });

    // The session id is minted lazily on the first captured event and expires on
    // idle / max length. It rides the same property store, so it is minted even
    // in memory mode (the mint is independent of the storage backing) — E6 needs
    // a session id regardless of persistence.
    this.session = new SessionIdManager({
      store: this.store,
      idleTimeoutMs: options.sessionIdleTimeoutMs,
      maxLengthMs: options.sessionMaxLengthMs,
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
    // Advance the idle clock from the EVENT timestamp and mint on expiry — a
    // stateful call, not a KV read. The facade leaves sessionId undefined; the
    // browser adapter is what stamps it.
    const timestamp = event.timestamp?.getTime() ?? Date.now();
    return { ...event, sessionId: this.session.checkAndGetSessionId(timestamp) };
  }

  private mergeSuperProperties(event: NeutralEvent): NeutralEvent {
    // Merge registered super-props into the event, trusted (they passed the E3
    // gate at registration — no re-gate). Super-props are defaults: a per-call
    // property of the same key wins. Library-computed / identity keys share the
    // store, so exclude them — they are stamped elsewhere, not consumer super-props.
    const superProps: NeutralProperties = {};
    for (const [key, value] of Object.entries(this.store.entries())) {
      if (RESERVED_EVENT_KEYS.has(key)) continue;
      superProps[key] = value;
    }
    if (Object.keys(superProps).length === 0) {
      return event;
    }
    return { ...event, properties: { ...superProps, ...event.properties } };
  }

  register(props: NeutralProperties, options?: RegisterOptions): void {
    if (options?.once) {
      this.store.registerOnce(props);
    } else {
      this.store.register(props);
    }
  }

  unregister(key: string): void {
    this.store.unregister(key);
  }

  identify(distinctId: string, traits?: NeutralTraits, traitsOnce?: NeutralTraits): void {
    // Client-side anon→identified merge guard (de-branded). Merge ONLY when the id
    // differs AND the actor is still anonymous: the identity store retains the prior
    // anon id and flips state to identified, and we emit a merge event carrying that
    // retained id as the [WIRE] link. A same-id re-identify, or a new id while
    // already identified, does NOT merge — it only carries the trait bags.
    const priorDistinctId = this.identity.getDistinctId();
    const shouldMerge =
      distinctId !== priorDistinctId &&
      this.identity.getIdentityState() === ANONYMOUS_IDENTITY_STATE;

    if (shouldMerge) {
      const retainedAnonId = this.identity.merge(distinctId);
      this.capture(this.buildMergeEvent(distinctId, retainedAnonId, traits, traitsOnce));
      return;
    }

    // No merge (same id, or a new id while already identified): update traits only.
    // Nothing to do when the caller supplied no traits — a bare re-identify is a
    // no-op (the traits-only path fires only when traits are present).
    if (traits === undefined && traitsOnce === undefined) {
      return;
    }
    this.capture(this.buildTraitsEvent(this.identity.getDistinctId(), traits, traitsOnce));
  }

  // The merge / traits event carries the two person-trait bags as adapter-internal
  // [WIRE] payload (mutable `traits` → set_traits, first-touch `traitsOnce` →
  // set_traits_once). On a key collision the mutable bag wins, mirroring
  // register / register_once precedence; the E5 wire-mapper normalizes the keys.
  private buildTraitsEvent(
    distinctId: string,
    traits?: NeutralTraits,
    traitsOnce?: NeutralTraits
  ): NeutralEvent {
    return {
      event: MERGE_EVENT,
      distinctId,
      properties: this.traitBags(traits, traitsOnce),
      timestamp: new Date(),
      dedupeId: generateUuidV7(),
    };
  }

  private buildMergeEvent(
    distinctId: string,
    retainedAnonId: string,
    traits?: NeutralTraits,
    traitsOnce?: NeutralTraits
  ): NeutralEvent {
    return {
      ...this.buildTraitsEvent(distinctId, traits, traitsOnce),
      properties: {
        [ANONYMOUS_DISTINCT_ID_KEY]: retainedAnonId,
        ...this.traitBags(traits, traitsOnce),
      },
    };
  }

  private traitBags(traits?: NeutralTraits, traitsOnce?: NeutralTraits): NeutralProperties {
    const bags: NeutralProperties = {};
    if (traits !== undefined) bags[SET_TRAITS_KEY] = { ...traits };
    if (traitsOnce !== undefined) bags[SET_TRAITS_ONCE_KEY] = { ...traitsOnce };
    return bags;
  }

  getDistinctId(): string {
    return this.identity.getDistinctId();
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
