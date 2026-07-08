import type {
  AnalyticsAdapter,
  ConsentState,
  NeutralEvent,
  NeutralProperties,
  NeutralTraits,
  NeutralFetchOptions,
  NeutralFetchResponse,
  RegisterOptions,
  ResetOptions,
} from 'analytics-kit';
import {
  buildPropsBackend,
  createMemoryBackend,
  localStorageBackend,
  resolveConsentBackend,
  DEFAULT_PERSISTENCE_MODE,
  type PersistenceMode,
  type StorageBackend,
} from './storage-backends';
import {
  consentStoreName,
  queueStoreName,
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
import { resolveIngestUrl } from './ingest-url';
import { mapEventToWire, assembleBatchBody, type WireEvent } from './wire-mapper';
import { RequestQueue } from './request-queue';
import { RetryQueue, isRetryableStatus, maxRetriesForStatus } from './retry-queue';
import { OfflineQueueStore } from './offline-queue';
import { generateUuidV7 } from './uuid-v7';
import { isLikelyBot } from './bot-detection';
import { RateLimiter, DEFAULT_BATCH_SCOPE } from './rate-limiter';
import { interpretBodyBackPressure } from './back-pressure-interpreter';
import { gzipCompress, gzipSyncFallback, isGzipSupported, isGzipData } from './gzip';
import { appendCompressedQueryParams, GZIP_CONTENT_TYPE, JSON_CONTENT_TYPE } from './transport-wire';
import { beaconSend, hasFetch, postViaXhr, KEEPALIVE_THRESHOLD_BYTES } from './transport';

const LIBRARY_ID = 'analytics-kit-browser';
const LIBRARY_VERSION = '0.0.0';

// Rapid writes are coalesced into one backend write; the in-memory props stay
// current synchronously, and pending writes flush on unload.
const SAVE_DEBOUNCE_MS = 250;

// The transport-ready batch body: a JSON string (uncompressed) or gzip bytes, plus
// its [WIRE] Content-Type. `compressed` records which path was taken so the transport
// knows whether to append the compression query params. Adapter-internal.
interface EncodedBatch {
  body: string | Uint8Array;
  contentType: string;
  compressed: boolean;
}

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
  // The bare ingest origin (e.g. https://analytics.example.com) the transport
  // POSTs to, plus an optional path override; the adapter appends its own [WIRE]
  // capture path when ingestPath is absent. No vendor host / region default.
  ingestHost?: string;
  ingestPath?: string;
  // Suppress bot/crawler traffic at capture time. On by default; set false to
  // disable UA filtering entirely so an otherwise-blocked client captures normally.
  botFilter?: boolean;
  // Consumer extension of the default UA denylist — extra case-insensitive
  // substrings that also flag a client as a bot.
  blockedUserAgents?: string[];
  // Batch transport timing: flush the buffered events on the EARLIER of this many
  // ms elapsing (clamped [250, 5000], default 3000) or flushAt events buffered
  // (default 20). Both optional with sane defaults.
  flushInterval?: number;
  flushAt?: number;
  // Gzip the batch body before sending. Defaults on where the native primitive
  // exists; set false to force S2's uncompressed JSON POST. A neutral boolean — the
  // wire encoding it selects (gzip, [WIRE] Content-Type/query params) stays internal.
  compression?: boolean;
}

export class BrowserAdapter implements AnalyticsAdapter {
  private readonly memoryBackend: StorageBackend;
  private readonly consent: ConsentStore;
  private readonly store: PersistenceStore;
  private readonly identity: IdentityStore;
  private readonly session: SessionIdManager;
  // Resolved at construction from config (host + optional path override), NOT the
  // property store — it is config, not persisted state. undefined when no
  // ingestHost is supplied (an unkeyed / no-delivery client). S2's POST reads this
  // via ingestUrl(); S5 appends its [WIRE] query params to the value it returns.
  private readonly resolvedIngestUrl: string | undefined;
  // Bot/crawler suppression config, resolved once at construction. Filtering is on
  // unless botFilter is explicitly false; blockedUserAgents extends the default denylist.
  private readonly botFilterEnabled: boolean;
  private readonly blockedUserAgents: string[];
  // The batch buffer. A pure timing/batching queue (paused at start); capture()
  // enqueues the mapped wire event, and the queue calls back to sendBatchWithRetry()
  // on the earlier of its interval or size trigger.
  private readonly queue: RequestQueue<WireEvent>;
  // The retry scheduler wrapping the batch POST failure path. On a transient
  // failure (network/status-0 or 5xx) the delivery re-enqueues here for a jittered
  // exponential retry; a 4xx is a permanent rejection and is never re-enqueued. The
  // retry state is entirely adapter-internal — it never reaches the neutral surface.
  private readonly retryQueue: RetryQueue<WireEvent>;
  // The offline-persistence sidecar (NEW WORK): mirrors the retry queue's
  // undelivered batches to durable storage so events captured offline survive a
  // reload, and rehydrates them on construction. It is a thin persistence wrapper —
  // the retry queue stays the in-memory retry engine; this only mirrors its snapshot
  // and reads it back. Gated on granted consent; entirely adapter-internal.
  private readonly offlineQueue: OfflineQueueStore<WireEvent>;
  // The client rate limiter. Two gates, both adapter-internal: a token bucket
  // throttles capture PROACTIVELY (over-limit events dropped before the queue), and
  // a per-scope server cool-off honours the backend's body-borne back-pressure
  // signal (read via the injected interpreter — the one [WIRE] place a backend's
  // signal field name lives). Neither reaches the neutral surface.
  private readonly rateLimiter: RateLimiter;
  // Whether to gzip the batch body. Resolved once at construction: the consumer's
  // opt-out (compression === false) always wins; otherwise it is on only where the
  // native/sync primitive can run. Adapter-internal — the wire encoding it drives
  // never reaches the neutral surface.
  private readonly compressionEnabled: boolean;
  // Removes the pagehide/visibilitychange/beforeunload listeners bound in the
  // constructor; undefined in a non-DOM (SSR/test) context where none were bound.
  private readonly detachUnloadListeners: (() => void) | undefined;
  // One-shot latch: a real page unload fires more than one lifecycle event, so the
  // beacon drain runs at most once — the second event is a no-op, not a beacon storm.
  private unloadDrained = false;

  constructor(options: BrowserAdapterOptions) {
    this.compressionEnabled = options.compression !== false && isGzipSupported();
    this.botFilterEnabled = options.botFilter !== false;
    this.blockedUserAgents = options.blockedUserAgents ?? [];
    this.rateLimiter = new RateLimiter({ interpretBackPressure: interpretBodyBackPressure });
    this.retryQueue = new RetryQueue<WireEvent>({
      send: (batch, attempt) => this.sendBatchWithRetry(batch, attempt),
    });
    this.queue = new RequestQueue<WireEvent>({
      send: (batch) => this.sendBatchWithRetry(batch, 0),
      flushInterval: options.flushInterval,
      flushAt: options.flushAt,
    });

    this.resolvedIngestUrl = resolveIngestUrl({
      ingestHost: options.ingestHost,
      ingestPath: options.ingestPath,
    });

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

    // The offline transport buffer rides the localStorage backend DIRECTLY (its own
    // graceful fallback), NOT the consent-swapped property store — persistence is
    // instead gated explicitly on live consent here, so an opted-out client persists
    // nothing without entangling the transport buffer in the identity store's
    // memory-swap machinery. It lives under its own store name (transport state, not
    // identity/super-props). Rehydrate now: read-then-clear any persisted undelivered
    // batches and hand them to the retry queue to re-send on this load.
    this.offlineQueue = new OfflineQueueStore<WireEvent>({
      backend: localStorageBackend,
      name: queueStoreName(options.key),
      isPersistenceAllowed: () => this.getConsentState() === 'granted',
    });
    for (const batch of this.offlineQueue.rehydrate()) {
      // Attempt-reset-on-reload is deliberate: uuid dedupe makes a re-send harmless and a 4xx prunes it on first re-send — do NOT persist the attempt count to "fix" this.
      this.retryQueue.scheduleRetry([...batch], 0);
    }

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

    this.detachUnloadListeners = this.bindUnloadListeners();
  }

  // Bind the page-lifecycle events that signal a close/navigation so buffered events
  // are beacon-drained before teardown. Mirrors RetryQueue's online/offline binding:
  // guarded for the non-DOM context, torn down on shutdown(). visibilitychange(hidden)
  // + pagehide are the bfcache-safe triggers; beforeunload is the legacy belt-and-braces.
  // Returns an unbinder, or undefined when there is no DOM to bind to.
  private bindUnloadListeners(): (() => void) | undefined {
    const win = typeof window === 'undefined' ? undefined : window;
    const doc = typeof document === 'undefined' ? undefined : document;
    if (win === undefined) {
      return undefined;
    }
    const onPageHide = (): void => this.unload();
    const onBeforeUnload = (): void => this.unload();
    const onVisibilityChange = (): void => {
      if (doc?.visibilityState === 'hidden') {
        this.unload();
      }
    };
    win.addEventListener('pagehide', onPageHide);
    win.addEventListener('beforeunload', onBeforeUnload);
    doc?.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      win.removeEventListener('pagehide', onPageHide);
      win.removeEventListener('beforeunload', onBeforeUnload);
      doc?.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }

  // The unload drain: beacon-send every buffered event so a last/pageleave event is not
  // dropped when the page closes. Drains BOTH queues — the S2 batch buffer AND the S3
  // retry queue (drain() = atomic take-all + teardown, no send) — via navigator.sendBeacon.
  // Idempotent: the latch guards against the several lifecycle events a real unload fires.
  // Best-effort and synchronous: the beacon body is encoded with the SYNC gzip primitive
  // (the async CompressionStream cannot resolve during teardown); S9 catches what beacon
  // cannot persist past the unload window. Adapter-internal — the transport never surfaces.
  /** @internal Public only so a unit test can invoke the drain without dispatching a real
   * DOM lifecycle event; not stable adapter API. */
  unload(): void {
    if (this.unloadDrained) {
      return;
    }
    this.unloadDrained = true;

    const url = this.ingestUrl();
    if (url === undefined) {
      // No ingest target: still take the buffers so they aren't left dangling, but there
      // is nowhere to beacon them.
      this.queue.drain();
      this.retryQueue.drain();
      return;
    }

    const batchBuffer = this.queue.drain();
    if (batchBuffer.length > 0) {
      this.beaconBatch(url, batchBuffer);
    }
    for (const retryBatch of this.retryQueue.drain()) {
      if (retryBatch.length > 0) {
        this.beaconBatch(url, [...retryBatch]);
      }
    }
  }

  // Assemble one batch's `data:[]` envelope and beacon it. Encoded synchronously (the
  // async gzip path can't resolve during unload): sync-gzip when compression is on,
  // else the JSON string. The [WIRE] compression query params ride the URL for the
  // gzip case, mirroring the normal binary POST. Body-type handling stays internal.
  private beaconBatch(url: string, batch: WireEvent[]): void {
    const json = assembleBatchBody(batch, Date.now());
    const encoded = this.encodeBatchSync(json);
    if (typeof encoded.body === 'string') {
      beaconSend(url, encoded.body, encoded.contentType);
      return;
    }
    const compressedUrl = appendCompressedQueryParams(url, LIBRARY_VERSION);
    beaconSend(compressedUrl, encoded.body, encoded.contentType);
  }

  // Synchronous batch encode for the beacon path: gzip via the SYNC fflate fallback
  // when compression is enabled and it yields valid gzip bytes, else the uncompressed
  // JSON string. Never the async native primitive — it cannot resolve during teardown.
  private encodeBatchSync(json: string): EncodedBatch {
    if (!this.compressionEnabled) {
      return { body: json, contentType: JSON_CONTENT_TYPE, compressed: false };
    }
    const sync = gzipSyncFallback(json);
    if (isGzipData(sync)) {
      return { body: sync, contentType: GZIP_CONTENT_TYPE, compressed: true };
    }
    return { body: json, contentType: JSON_CONTENT_TYPE, compressed: false };
  }

  capture(event: NeutralEvent): void {
    // Bot/crawler suppression gates capture BEFORE the enrichment pipeline and
    // before the enqueue — a blocked client's event never enters the queue.
    if (this.isBot()) {
      return;
    }
    // Client rate limit: a token bucket throttles proactively. An over-limit event
    // (a runaway loop) is dropped here — before the enrichment cost, before the
    // queue — rather than flooding the endpoint. Sits alongside the bot gate.
    if (!this.rateLimiter.consumeToken()) {
      return;
    }
    // Run the enrichment pipeline (S7 super-props + S8 session stamp), map to the
    // [WIRE] shape, then buffer it. The queue flushes on its interval / size trigger;
    // sendBatch() POSTs. enable() is idempotent — the first capture arms the queue.
    const enriched = this.runCapturePipeline(event);
    this.queue.enable();
    this.queue.enqueue(this.toWireEvent(enriched));
  }

  private isBot(): boolean {
    if (!this.botFilterEnabled) {
      return false;
    }
    // Defensive navigator read: DOM-typed under lib:["ES2022","DOM"], but the
    // adapter stays safe in a non-DOM test/SSR context (mirrors consent.ts).
    const nav = typeof navigator === 'undefined' ? undefined : navigator;
    return isLikelyBot(nav, this.blockedUserAgents);
  }

  /** @internal Public only so pass-through tests can pin the enrichment pipeline; not stable adapter API. */
  runCapturePipeline(event: NeutralEvent): NeutralEvent {
    return this.mergeSuperProperties(this.stampSessionId(event));
  }

  /** @internal The adapter's wire-mapping seam: lay a pipeline-processed NeutralEvent
   * out into its [WIRE] shape, placing the neutral `dedupeId` at the top-level `uuid`.
   * S2's batch queue calls this per event before enqueue; S2 extends the wire-mapper
   * module (not this method) with the MERGE_EVENT / traits-key normalization. Adapter-
   * internal — the WireEvent shape never reaches the neutral surface. */
  toWireEvent(event: NeutralEvent): WireEvent {
    return mapEventToWire(event);
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
    const bags = this.traitBags(traits, traitsOnce);
    return {
      ...this.buildTraitsEvent(distinctId, traits, traitsOnce),
      properties: {
        [ANONYMOUS_DISTINCT_ID_KEY]: retainedAnonId,
        ...bags,
      },
    };
  }

  private traitBags(traits?: NeutralTraits, traitsOnce?: NeutralTraits): NeutralProperties {
    const bags: NeutralProperties = {};
    if (traits !== undefined) bags[SET_TRAITS_KEY] = { ...traits };
    if (traitsOnce !== undefined) bags[SET_TRAITS_ONCE_KEY] = { ...traitsOnce };
    return bags;
  }

  reset(options?: ResetOptions): void {
    // Clear identity + persistence + session as one transition. The identity store
    // owns the [WIRE] keys: it snapshots the device id, clears the store, re-mints
    // the anonymous distinct id (keeping the device id unless resetDevice), and
    // flips state to anonymous. Then reset the session so the next captured event
    // mints a fresh id. All storage writes ride the (consent-gated) property store,
    // so an opted-out client writes nothing to durable storage.
    this.identity.reset(options);
    this.session.resetSessionId();
  }

  getDistinctId(): string {
    return this.identity.getDistinctId();
  }

  group(): void {}

  alias(): void {}

  async flush(): Promise<void> {
    // Force an immediate drain (bypassing the interval / size trigger) and resolve
    // once the POST it fires — plus any auto-flush POST still on the wire — settle.
    await this.queue.flushNow();
  }

  async shutdown(): Promise<void> {
    // Unbind the page-lifecycle listeners so a post-shutdown unload can't re-drain, then
    // flush any remaining buffer through the normal transport.
    this.detachUnloadListeners?.();
    await this.flush();
  }

  // The retry-wrapped batch delivery the request queue and retry queue both call
  // back into. POSTs the batch; on a transient failure (network/status-0 or 5xx,
  // within the per-status budget) it re-enqueues the SAME WireEvent[] for a jittered
  // retry — re-assembling the envelope against a fresh send-time Date.now() each
  // attempt so event ages stay correct. A 4xx is a permanent rejection: dropped, not
  // retried. Returns void to the request queue (its send boundary is untouched);
  // retry state lives in the retry queue, all adapter-internal.
  private async sendBatchWithRetry(batch: WireEvent[], attempt: number): Promise<void> {
    const response = await this.postBatch(batch);
    if (response === undefined) {
      // No send happened (no target / empty / cooling off) — the retry queue is
      // unchanged, so the durable mirror is too. Nothing to re-persist.
      return;
    }
    if (isRetryableStatus(response.status) && attempt < maxRetriesForStatus(response.status)) {
      this.retryQueue.scheduleRetry(batch, attempt);
    }
    // Mirror the retry queue's current undelivered set to durable storage after
    // every send outcome. A grow (a newly scheduled retry), a prune (this batch was
    // delivered, permanently rejected, or exhausted its budget — so it is no longer
    // in the snapshot), and the size cap all fall out of re-persisting the snapshot.
    this.offlineQueue.persist(this.retryQueue.snapshot());
  }

  // The adapter-owned batch POST: build the [WIRE] `data:[]` envelope, encode it
  // (gzip when compression is enabled, else uncompressed JSON), and POST it to the
  // S1-resolved ingest URL — returning the neutral response so the retry wrapper can
  // read its status. When no ingest target is configured, the batch is empty, or the
  // scope is inside its server cool-off window, nothing is sent and undefined is
  // returned — which the retry wrapper already treats as an indistinguishable no-op,
  // keeping the proactive cool-off from tangling with S3's reactive retry. After a
  // completed POST, the backend's back-pressure signal is read off the response body
  // (via the injected interpreter) and arms the affected scope's cool-off. The gzip
  // encode + its [WIRE] Content-Type/query params live below this method, in
  // encodeBatch() / postEncoded() — never on the neutral surface.
  private async postBatch(batch: WireEvent[]): Promise<NeutralFetchResponse | undefined> {
    const url = this.ingestUrl();
    if (url === undefined || batch.length === 0) {
      return undefined;
    }
    if (this.rateLimiter.isCoolingOff(DEFAULT_BATCH_SCOPE)) {
      return undefined;
    }
    const json = assembleBatchBody(batch, Date.now());
    const encoded = await this.encodeBatch(json);
    const response = await this.postEncoded(url, encoded);
    await this.rateLimiter.interpretBackPressure(response);
    return response;
  }

  // Encode the JSON envelope for transport: gzip it when compression is enabled,
  // preferring the native async primitive and falling back to the sync one. Output
  // validation happens inside gzipCompress (returns null on any failure); a final
  // isGzipData guard catches a native path that silently returned non-gzip bytes.
  // On ANY compression failure the UNCOMPRESSED JSON string is returned rather than
  // corrupt bytes — the caller ships plain JSON. Adapter-internal encoding.
  private async encodeBatch(json: string): Promise<EncodedBatch> {
    if (!this.compressionEnabled) {
      return { body: json, contentType: JSON_CONTENT_TYPE, compressed: false };
    }
    const native = await gzipCompress(json);
    if (native !== null && isGzipData(native)) {
      return { body: native, contentType: GZIP_CONTENT_TYPE, compressed: true };
    }
    const sync = gzipSyncFallback(json);
    if (isGzipData(sync)) {
      return { body: sync, contentType: GZIP_CONTENT_TYPE, compressed: true };
    }
    return { body: json, contentType: JSON_CONTENT_TYPE, compressed: false };
  }

  // The single adapter-internal transport. Selects the delivery mechanism by runtime
  // availability — fetch preferred, XHR the fallback — behind the neutral fetch() SPI,
  // which never learns of the choice. A string body (uncompressed, or compression off)
  // rides the neutral fetch() SPI on the fetch path: the string-delivery contract
  // consumers and a second adapter share, and the fetch-transport branch these tests
  // intercept. A binary (gzipped) body cannot cross that string-bodied SPI, so it goes
  // to the DOM fetch directly, below the seam, with the [WIRE] compression=/ver=/_=
  // query params appended and keepalive set for a POST under the ~52 KB cap. sendBeacon
  // is NOT a normal-POST transport — it is the unload-drain path only (see unload()).
  private async postEncoded(url: string, encoded: EncodedBatch): Promise<NeutralFetchResponse> {
    if (typeof encoded.body === 'string') {
      // fetch preferred: the neutral SPI is the fetch-transport branch. When fetch is
      // absent at runtime, fall to a direct XHR POST — both resolve the neutral response.
      if (hasFetch()) {
        return this.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': encoded.contentType },
          body: encoded.body,
        });
      }
      // The XHR fallback is NOT unload-safe; the unload drain relies on sendBeacon (see unload()), never this path.
      return postViaXhr(url, {
        method: 'POST',
        headers: { 'Content-Type': encoded.contentType },
        body: encoded.body,
      });
    }
    const compressedUrl = appendCompressedQueryParams(url, LIBRARY_VERSION);
    // Copy into a fresh ArrayBuffer so the BodyInit is a plain (non-shared) buffer.
    const buffer = encoded.body.slice().buffer as ArrayBuffer;
    const headers = { 'Content-Type': encoded.contentType };
    if (hasFetch()) {
      return fetch(compressedUrl, {
        method: 'POST',
        headers,
        body: buffer,
        // Best-effort delivery for a closing page; only ever set under the ~52 KB cap
        // (over it, fetch keepalive errors). The gzipped body is near-always well under.
        keepalive: encoded.body.byteLength < KEEPALIVE_THRESHOLD_BYTES,
      });
    }
    return postViaXhr(compressedUrl, { method: 'POST', headers, body: buffer });
  }

  getConsentState(): ConsentState {
    return this.consent.get();
  }

  setConsentState(state: ConsentState): void {
    // Opt-out contract (E4-S3): a denial DROPS the unsent buffer without flushing —
    // events captured before the opt-out must not leave the app. optIn ('granted')
    // does NOT drop. The drop is additive to the durable consent write below. It
    // also drops the persisted offline queue, so events captured before the opt-out
    // cannot rehydrate and re-send after a reload.
    if (state === 'denied') {
      this.queue.drop();
      this.offlineQueue.drop();
    }
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

  /** @internal The resolved ingest target for the transport POST; consumed by the
   * batch queue in E5-S2 (and the [WIRE] query params appended in E5-S5). Adapter-
   * internal — never on the neutral surface. undefined when no ingestHost is set. */
  ingestUrl(): string | undefined {
    return this.resolvedIngestUrl;
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
