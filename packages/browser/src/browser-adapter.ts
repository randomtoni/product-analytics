import {
  RESERVED_PAGELEAVE_EVENT,
  type AnalyticsAdapter,
  type ConsentState,
  type NeutralEvent,
  type NeutralProperties,
  type NeutralTraits,
  type NeutralFetchOptions,
  type NeutralFetchResponse,
  type RegisterOptions,
  type ResetOptions,
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
  SESSION_ENTRY_PROPS_KEY,
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
import { buildContext } from './context-enrichment';
import {
  buildEntryInfo,
  deriveInitialProps,
  deriveSessionEntryProps,
  parseCampaignParams,
  type EntryInfo,
} from './attribution-enrichment';

const LIBRARY_ID = 'analytics-kit-browser';
const LIBRARY_VERSION = '0.0.0';

// The pageleave's library-computed link back to the pageview it closes: the elapsed
// time on page, the pageview id, and the pathname. Neutral keys (de-branded from
// posthog's $prev_pageview_duration/$prev_pageview_id/$prev_pageview_pathname). Library-
// computed ⇒ trusted: added downstream of the E3 facade allowlist, never gated.
const PREV_PAGEVIEW_DURATION_KEY = 'prev_pageview_duration';
const PREV_PAGEVIEW_ID_KEY = 'prev_pageview_id';
const PREV_PAGEVIEW_PATHNAME_KEY = 'prev_pageview_pathname';
const MS_PER_SECOND = 1000;

// The current path, read defensively so the adapter stays safe in a non-DOM
// (SSR/test) context — mirrors the navigator guard in isBot(). Empty string when
// there is no location.
function currentPathname(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.location?.pathname ?? '';
}

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

// The in-memory current-pageview record (neutral keys — no $-prefix). Minted when a
// `page` event flows through capture() so E6-S2 can compute now − timestamp for a
// pageleave duration; cleared on session rotation to start a fresh lineage.
// Adapter-internal — never reaches the neutral surface.
interface CurrentPageview {
  timestamp: number;
  pageViewId: string;
  pathname: string;
}

// The persisted per-session entry snapshot (E6-S4): the raw {referrer, url} the
// `session_entry_*` props derive from, tagged with the session id it was captured under
// so its lifespan equals that session's. Reset (re-captured) when the session rotates or
// on first adoption. Persisted under SESSION_ENTRY_PROPS_KEY (survives a reload within
// the session) and excluded from the super-prop merge via RESERVED_EVENT_KEYS — the raw
// snapshot never rides events, only the derived `session_entry_*` keys do.
interface StoredSessionEntry {
  sessionId: string;
  info: EntryInfo;
}

// The verdict of comparing a freshly-stamped session id against the last one seen. Drives
// two independent per-session records off ONE comparison: 'adopted' is the first
// undefined→id transition, 'rotated' is a change to a different id (idle/max expiry or
// reset), 'same' is a continuing session. The pageview record clears on 'rotated' only;
// the session-entry snapshot re-captures on 'adopted' OR 'rotated' (there is no prior
// entry to keep on the first session).
type SessionTransition = 'adopted' | 'rotated' | 'same';

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
  // Mint a pageleave at unload (time-on-page), riding the beacon drain. Defaults ON
  // when pageview capture is in use (posthog's `capture_pageleave: 'if_capture_pageview'`
  // default, de-branded) — R1 pageviews are always available, so on unless explicitly
  // false. A plain boolean here; E6-S5 rewires this into the structured `enrichment`
  // object.
  capturePageleave?: boolean;
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
  // The current-pageview record, set when a `page` event flows through capture()
  // and read by E6-S2 at unload to compute the pageleave duration. undefined before
  // the first page event and after a session rotation clears it.
  private currentPageview: CurrentPageview | undefined;
  // The last session id observed on a captured event. Adapter-side rotation detector:
  // classifySessionTransition() compares the freshly-stamped id against this and returns
  // an adopted/rotated/same verdict; commitSessionTransition() writes it exactly once per
  // pipeline pass. ONE comparison serves both the pageview-record clear (E6-S1) and the
  // per-session entry-prop recapture (E6-S4). Adapter-internal.
  private lastSeenSessionId: string | undefined;
  // Whether unload() mints a pageleave. Resolved once at construction: on unless the
  // consumer explicitly disables it (posthog's if_capture_pageview default, de-branded —
  // R1 pageview capture is always available). E6-S5 rewires this into `enrichment`.
  private readonly capturePageleaveEnabled: boolean;

  constructor(options: BrowserAdapterOptions) {
    this.compressionEnabled = options.compression !== false && isGzipSupported();
    this.capturePageleaveEnabled = options.capturePageleave !== false;
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

    // Mint the pageleave BEFORE the drain and BEFORE the no-target branch: capture()
    // enqueues it synchronously, so it rides the very next drain()'s beacon. On a
    // no-target unload it lands in the buffer that is then drained-and-discarded —
    // harmless. The latch above makes this fire at most once per unload.
    this.capturePageleave();

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
    const stamped = this.stampSessionId(event);
    // ONE session-transition verdict drives both per-session records; commit the id last
    // (below) so a second reader can't compare against an already-overwritten value.
    const transition = this.classifySessionTransition(stamped.sessionId);
    this.trackPageview(stamped, transition);
    this.maintainSessionEntry(stamped.sessionId, transition);
    this.writeInitialProps();
    this.commitSessionTransition(stamped.sessionId);
    return this.enrichAttribution(this.enrichContext(this.mergeSuperProperties(stamped)));
  }

  // Merge the fresh-per-event auto-context (page / device / referrer / timezone / lib)
  // into the event as the OUTERMOST wrap, AFTER super-props. Context keys are library-
  // computed ⇒ trusted (no allowlist re-gate). They are defaults: a per-call consumer
  // prop (or a super-prop already merged in) of the same key WINS — the spread order
  // (context first, incoming bag last) mirrors mergeSuperProperties.
  private enrichContext(event: NeutralEvent): NeutralEvent {
    const context = buildContext({
      libraryId: this.getLibraryId(),
      libraryVersion: this.getLibraryVersion(),
    });
    return { ...event, properties: { ...context, ...event.properties } };
  }

  // Maintain the current-pageview record off the session-stamped event. A ROTATED
  // transition clears the record first; then a `page` event mints a fresh record.
  // Ordering matters: rotate-then-set, so a `page` that arrives on the first event of a
  // new session starts the new lineage rather than being wiped. Adoption does NOT clear
  // (the pageview record is minted lazily by the page event itself, not at session start).
  private trackPageview(event: NeutralEvent, transition: SessionTransition): void {
    if (transition === 'rotated') {
      this.currentPageview = undefined;
    }
    // Recognize a pageview by the neutral marker the facade page() path stamps — NOT
    // by the event name, which is the router path/name for a named page('/x'). Keying
    // off the name would miss every real router-driven pageview.
    if (event.isPageView !== true) {
      return;
    }
    this.currentPageview = {
      timestamp: event.timestamp?.getTime() ?? Date.now(),
      pageViewId: generateUuidV7(),
      pathname: currentPathname(),
    };
  }

  // Adapter-side session-transition verdict (no onSessionId observer on the pure
  // SessionIdManager). Compare the freshly-stamped id against the last one seen WITHOUT
  // committing it — the commit is a separate single write so a second reader in the same
  // pass sees the same prior value. The first undefined→id transition is adoption; a
  // change to a different id is a rotation (idle/max-length expiry or reset); an unchanged
  // id is a continuing session.
  private classifySessionTransition(sessionId: string | undefined): SessionTransition {
    if (this.lastSeenSessionId === undefined) {
      return sessionId === undefined ? 'same' : 'adopted';
    }
    return sessionId !== this.lastSeenSessionId ? 'rotated' : 'same';
  }

  // Commit the observed session id exactly once per pipeline pass, after every reader of
  // the transition verdict has run.
  private commitSessionTransition(sessionId: string | undefined): void {
    this.lastSeenSessionId = sessionId;
  }

  // Per-SESSION entry props (E6-S4). Re-capture the raw {referrer, url} snapshot on
  // 'adopted' (first session — nothing to keep) OR 'rotated' (a new session — the prior
  // entry belonged to the old one); a 'same' transition keeps the stored snapshot. The
  // snapshot is persisted keyed by the session id it was captured under, so its lifespan
  // equals the session's and it survives a mid-session reload. Reset via the SAME
  // transition verdict that drives the pageview clear — one rotation-detection mechanism.
  private maintainSessionEntry(
    sessionId: string | undefined,
    transition: SessionTransition
  ): void {
    if (sessionId === undefined) {
      return;
    }
    if (transition === 'adopted' || transition === 'rotated') {
      const entry: StoredSessionEntry = { sessionId, info: buildEntryInfo() };
      this.store.register({ [SESSION_ENTRY_PROPS_KEY]: entry });
    }
  }

  // Set-once-per-IDENTITY initial attribution props (E6-S4). Route the derived `initial_*`
  // keys through the EXISTING set-once persistence (registerOnce): written on first touch
  // and never overwritten by a later capture carrying different params. Idempotent — after
  // the first write every key is already present, so subsequent calls are no-ops.
  private writeInitialProps(): void {
    const initial = deriveInitialProps(buildEntryInfo());
    if (Object.keys(initial).length > 0) {
      this.store.registerOnce(initial);
    }
  }

  // Merge the attribution enrichment (E6-S4) into the event as defaults, AFTER context:
  // fresh per-event campaign params from the live URL + the re-emitted per-session
  // `session_entry_*` keys from the stored snapshot. Every key is library-computed ⇒
  // trusted (derived from URL/referrer, never consumer props) — no allowlist re-gate. A
  // per-call consumer prop of the same key still WINS (context/attribution spread first,
  // incoming bag last). The `initial_*` set-once props ride via the super-prop merge, not
  // here (they live in the store, written by writeInitialProps).
  private enrichAttribution(event: NeutralEvent): NeutralEvent {
    const attribution: NeutralProperties = {
      ...parseCampaignParams(),
      ...this.sessionEntryProps(),
    };
    if (Object.keys(attribution).length === 0) {
      return event;
    }
    return { ...event, properties: { ...attribution, ...event.properties } };
  }

  // Derive the `session_entry_*` keys from the stored snapshot, but ONLY when it matches
  // the current session id — a stale snapshot (its session rotated) emits nothing until
  // maintainSessionEntry re-captures. Empty before any session id exists.
  private sessionEntryProps(): NeutralProperties {
    const stored = this.store.getProperty<StoredSessionEntry>(SESSION_ENTRY_PROPS_KEY);
    if (stored === undefined || stored.sessionId !== this.lastSeenSessionId) {
      return {};
    }
    return deriveSessionEntryProps(stored.info);
  }

  /** @internal The adapter's wire-mapping seam: lay a pipeline-processed NeutralEvent
   * out into its [WIRE] shape, placing the neutral `dedupeId` at the top-level `uuid`.
   * S2's batch queue calls this per event before enqueue; S2 extends the wire-mapper
   * module (not this method) with the MERGE_EVENT / traits-key normalization. Adapter-
   * internal — the WireEvent shape never reaches the neutral surface. */
  toWireEvent(event: NeutralEvent): WireEvent {
    return mapEventToWire(event);
  }

  /** @internal The current-pageview record (undefined before the first `page` event
   * and after a session rotation). E6-S2 reads this at unload to compute the pageleave
   * duration; a unit test reads it to pin the record. Adapter-internal — never on the
   * neutral surface. */
  currentPageviewRecord(): CurrentPageview | undefined {
    return this.currentPageview;
  }

  // Mint the pageleave for the current pageview and route it through capture() so it
  // rides the unload beacon (enqueued synchronously just before drain()). Fires ONLY
  // when a pageview record exists (a page was captured this session) AND the toggle is
  // on. The duration/id/pathname are library-computed ⇒ trusted (no allowlist gating —
  // capture() is downstream of the E3 facade gate). Inherits capture()'s bot gate +
  // rate limiter by construction. Idempotent via unload()'s latch (called once).
  private capturePageleave(): void {
    if (!this.capturePageleaveEnabled) {
      return;
    }
    const record = this.currentPageview;
    if (record === undefined) {
      return;
    }
    // Duration in SECONDS, matching posthog's $prev_pageview_duration (page-view.ts:157
    // divides ms by 1000) so a downstream consumer sees the same unit as other durations.
    const durationSeconds = (Date.now() - record.timestamp) / MS_PER_SECOND;
    this.capture({
      event: RESERVED_PAGELEAVE_EVENT,
      distinctId: this.identity.getDistinctId(),
      properties: {
        [PREV_PAGEVIEW_DURATION_KEY]: durationSeconds,
        [PREV_PAGEVIEW_ID_KEY]: record.pageViewId,
        [PREV_PAGEVIEW_PATHNAME_KEY]: record.pathname,
      },
      timestamp: new Date(),
      dedupeId: generateUuidV7(),
    });
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
