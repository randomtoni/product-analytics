import {
  RESERVED_PAGELEAVE_EVENT,
  resolveOptedOut,
  type AnalyticsAdapter,
  type ConsentState,
  type EnrichmentConfig,
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
  AUTOCAPTURE_EVENT,
  GROUP_IDENTIFY_EVENT,
  GROUP_KEY_KEY,
  GROUP_SET_KEY,
  GROUP_TYPE_KEY,
  GROUPS_KEY,
  internalKeyPolicy,
  MERGE_EVENT,
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
import { isGzipSupported } from './gzip';
import { appendCompressedQueryParams } from './transport-wire';
import { beaconSend } from './transport';
import { encodeBody, encodeBodySync, postEncoded } from './encoded-post';
import { LIBRARY_VERSION } from './library-version';
import { buildContext } from './context-enrichment';
import {
  buildEntryInfo,
  deriveInitialProps,
  deriveSessionEntryProps,
  parseCampaignParams,
  INITIAL_PROPS_SENTINEL_KEY,
  type EntryInfo,
} from './attribution-enrichment';
import { bindAutocaptureListeners } from './autocapture';

const LIBRARY_ID = 'analytics-kit-browser';

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

// The distinct "nothing sent because the scope is inside its server cool-off" outcome
// of a batch POST — separate from an `undefined` no-target/empty result and from a real
// response. A cool-off is NOT a delivery failure: the batch was already drained from the
// request queue, so the caller must RE-HOLD it (reschedule at the same attempt), not
// treat it as a clean no-op. Adapter-internal.
const COOLING_OFF: unique symbol = Symbol('cooling-off');
type PostBatchResult = NeutralFetchResponse | typeof COOLING_OFF | undefined;

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
// the session) and excluded from the super-prop merge via its 'hidden' internalKeyPolicy —
// the raw snapshot never rides events, only the derived `session_entry_*` keys do.
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
  // false. Legacy internal fallback: `enrichment.pageleave` is now the authoritative
  // config-driven toggle (threaded through resolveAdapter); this plain boolean is read
  // only when `enrichment.pageleave` is absent.
  capturePageleave?: boolean;
  // Per-module enrichment opt-out (E6-S5). The single structured object the seam
  // `AnalyticsConfig.enrichment` threads through here. Each toggle defaults ON (absent
  // ⇒ enriched); setting one false disables ONLY that module. Gates S3's page/device/
  // referrer context groups, S4's utm campaign parse, and S2's pageleave independently.
  enrichment?: EnrichmentConfig;
  // Signal the backend to skip its server-side GeoIP (E6-S6). A library-SET toggle, not
  // a consumer value, so it does NOT cross the E3 allowlist — it stamps the adapter-internal
  // [WIRE] $geoip_disable property (via the wire-mapper). The country VALUE, by contrast, is
  // consumer-supplied and routes through the facade register() gate, never through here.
  disableGeoip?: boolean;
  // Opt into minimal DOM autocapture (E6-S7). Default OFF: unset/false binds ZERO DOM
  // listeners and captures nothing. When true, capture-phase click/change/submit listeners
  // are bound (SSR-guarded), each interaction minting a neutral autocapture event through
  // the SAME capture() pipeline. On/off is purely local — no remote-config phone-home.
  autocapture?: boolean;
  // The consent-default policy (E4-S3), threaded from the seam config so the adapter's
  // capture gate mirrors the facade's resolveOptedOut: a 'pending' client CAPTURES only
  // when this is 'granted' (opt-in-by-default), and is DROPPED otherwise (the fail-safe).
  // Capture-permission only — cookie persistence still keys off RAW 'granted' consent, so
  // a pending+defaultGranted client captures yet writes no cookies until an explicit grant.
  consentDefault?: ConsentState;
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
  // Removes the capture-phase click/change/submit autocapture listeners (E6-S7);
  // undefined when autocapture is off OR in a non-DOM (SSR) context where none were bound.
  private readonly detachAutocaptureListeners: (() => void) | undefined;
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
  // Subscribers notified when the session id rotates (the replay recorder re-keys its
  // recording off this). A notification EDGE off the ONE existing rotation verdict
  // (classifySessionTransition), not a second detector — fired from commitSessionTransition's
  // call site on a 'rotated' transition, primed with the current id on subscribe.
  private readonly sessionRotatedListeners = new Set<(sessionId: string | undefined) => void>();
  // Whether unload() mints a pageleave. Resolved once at construction from the E6-S5
  // structured `enrichment.pageleave` toggle (authoritative), falling back to the legacy
  // `capturePageleave` boolean when absent; on unless explicitly disabled (posthog's
  // if_capture_pageview default, de-branded — R1 pageview capture is always available).
  private readonly capturePageleaveEnabled: boolean;
  // The per-module enrichment opt-out set (E6-S5), stored so each context/attribution
  // group reads its toggle per event. Absent object or absent key ⇒ that module is ON
  // (opt-out semantics). Only the page/device/referrer/utm gates read it live; pageleave
  // is resolved once into capturePageleaveEnabled above.
  private readonly enrichment: EnrichmentConfig;
  // Whether to stamp the [WIRE] $geoip_disable flag on every wire event (E6-S6). Resolved
  // once at construction; a library-set toggle, off unless explicitly true. Adapter-internal —
  // it drives only the wire-mapper stamp, never the neutral surface.
  private readonly disableGeoip: boolean;
  // The consent-default policy (E4-S3): the tri-state the capture gate resolves a 'pending'
  // consent against, mirroring the facade's resolveOptedOut. Only 'granted' opts a pending
  // client IN; unset/'denied' keeps the fail-safe drop. Does NOT relax cookie persistence.
  private readonly consentDefault: ConsentState | undefined;
  // The ingest auth key (config), stamped in-body on every wire event's properties by the
  // wire-mapper so the batch endpoint authenticates each event. The KEY VALUE is config;
  // it never surfaces on the neutral seam — it rides only the [WIRE] token property.
  private readonly apiKey: string;
  // The RAW configured persistence mode + cookie options, stored so a runtime grant can
  // rebuild the durable props backend with the SAME buildPropsBackend call the constructor
  // uses when consent is granted. The construction-time effectiveMode collapses to memory
  // under a non-granted decision; these hold the un-collapsed config so promotion targets
  // the real durable backend.
  private readonly persistenceMode: PersistenceMode;
  private readonly cookieDomain: string | undefined;
  private readonly crossSubdomainCookie: boolean | undefined;

  constructor(options: BrowserAdapterOptions) {
    this.apiKey = options.key;
    this.compressionEnabled = options.compression !== false && isGzipSupported();
    this.enrichment = options.enrichment ?? {};
    this.disableGeoip = options.disableGeoip === true;
    this.consentDefault = options.consentDefault;
    this.capturePageleaveEnabled =
      (options.enrichment?.pageleave ?? options.capturePageleave) !== false;
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
    this.persistenceMode = mode;
    this.cookieDomain = options.cookieDomain;
    this.crossSubdomainCookie = options.crossSubdomainCookie;
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
    // identity/super-props).
    //
    // MULTI-TAB: the durable key is namespaced with a per-INSTANCE tab id (a fresh uuid
    // per tab/load), so persist/drop touch only THIS tab's key and a second tab's empty
    // snapshot can never clobber this tab's mirrored batches. All a project's tab keys
    // share the `queueStoreName(options.key)` base prefix so rehydrate can scan them.
    // Rehydrate now: read-then-clear EVERY tab's persisted undelivered batches (own key +
    // orphans from closed tabs), union them, and hand them to the retry queue to re-send.
    // A fresh uuid per instance — NOT deviceIdGenerator (that mints the STABLE device
    // identity, shared across tabs/reloads); the tab id must be unique per tab/load so
    // two tabs never share a key. generateUuidV7 is the same fresh-per-call minter the
    // adapter uses for pageview / dedupe ids.
    const queuePrefix = `${queueStoreName(options.key)}__`;
    const tabId = generateUuidV7();
    this.offlineQueue = new OfflineQueueStore<WireEvent>({
      backend: localStorageBackend,
      name: `${queuePrefix}${tabId}`,
      scanPrefix: queuePrefix,
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
    // Autocapture is opt-in, default OFF (E6-S7): bind the DOM listeners ONLY when the
    // config boolean is explicitly true. Unset/false ⇒ this is undefined ⇒ zero listeners,
    // zero events. No remote-config gate — on/off is purely this local flag.
    this.detachAutocaptureListeners =
      options.autocapture === true ? this.bindAutocapture() : undefined;
  }

  // Bind the capture-phase autocapture listeners (SSR-guarded inside the module, exactly
  // like bindUnloadListeners). Each DOM interaction mints a neutral autocapture event that
  // rides the SAME capture() pipeline (consent gate → bot gate → rate limiter → enrichment →
  // wire map → transport). Element metadata is library-computed ⇒ TRUSTED — it is NOT
  // allowlist-gated. Returns an unbinder, or undefined in a non-DOM context. NO gating
  // network call — the listeners are bound purely from config.
  private bindAutocapture(): (() => void) | undefined {
    return bindAutocaptureListeners((properties) => {
      this.capture({
        event: AUTOCAPTURE_EVENT,
        internalKind: 'autocapture',
        distinctId: this.identity.getDistinctId(),
        properties,
        timestamp: new Date(),
        dedupeId: generateUuidV7(),
      });
    });
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
      } else if (doc?.visibilityState === 'visible') {
        // Returning to the tab re-arms the one-shot unload latch: without this, the first
        // tab switch would set unloadDrained permanently, and no later hide would ever
        // drain or mint a pageleave again.
        this.unloadDrained = false;
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
    const encoded = encodeBodySync(json, this.compressionEnabled);
    if (typeof encoded.body === 'string') {
      beaconSend(url, encoded.body, encoded.contentType);
      return;
    }
    const compressedUrl = appendCompressedQueryParams(url, LIBRARY_VERSION);
    beaconSend(compressedUrl, encoded.body, encoded.contentType);
  }

  capture(event: NeutralEvent): void {
    // Consent is the FIRST gate — before bot filtering and before a rate-limit token
    // is spent. This is the single choke point every internal caller funnels through
    // (autocapture listeners, the unload pageleave, identify's merge/traits events), so a
    // suppressed client captures nothing even for events minted directly on the live
    // adapter, bypassing the facade's opt-out swap.
    if (this.captureSuppressed()) {
      return;
    }
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

  // Whether capture is suppressed by consent. Delegates to the seam's shared resolveOptedOut
  // so a direct live-adapter caller (autocapture, the unload pageleave, identify's merge/traits
  // events) obeys the SAME opt-out contract the facade swap enforces — one source of truth, no
  // mirrored copy to drift. getConsentState() already folds a DNT/GPC signal to 'denied', so a
  // DNT client is suppressed here for free. Capture-permission ≠ cookie-permission: this can
  // allow a pending+defaultGranted client to CAPTURE while cookie persistence (keyed off RAW
  // 'granted') stays memory-only.
  private captureSuppressed(): boolean {
    return resolveOptedOut(this.getConsentState(), this.consentDefault);
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
    if (transition === 'rotated') {
      this.notifySessionRotated(stamped.sessionId);
    }
    return this.enrichAttribution(this.enrichContext(this.mergeSuperProperties(stamped)));
  }

  // Merge the fresh-per-event auto-context (page / device / referrer / timezone / lib)
  // into the event as the OUTERMOST wrap, AFTER super-props. Context keys are library-
  // computed ⇒ trusted (no allowlist re-gate). They are defaults: a per-call consumer
  // prop (or a super-prop already merged in) of the same key WINS — the spread order
  // (context first, incoming bag last) mirrors mergeSuperProperties.
  private enrichContext(event: NeutralEvent): NeutralEvent {
    // A scoped context view (E6-S8) carries its resolved enrichment override on the event;
    // absent (a root capture) falls back to the adapter's own instance config. Identity/
    // session/transport are untouched — only these live per-event toggles vary per context.
    const enrichment = event.enrichmentProfile ?? this.enrichment;
    const context = buildContext(
      {
        libraryId: this.getLibraryId(),
        libraryVersion: this.getLibraryVersion(),
      },
      {
        page: enrichment.page,
        device: enrichment.device,
        referrer: enrichment.referrer,
      }
    );
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

  // Fan the ONE rotation verdict out to every subscriber (the replay recorder re-keys off
  // it). Called from the verdict site on a 'rotated' transition — never on its own timer, so
  // it inherits the verdict's capture-gated firing cadence (see getReplaySessionId note).
  private notifySessionRotated(sessionId: string | undefined): void {
    for (const listener of this.sessionRotatedListeners) {
      listener(sessionId);
    }
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
    // registerOnce already no-ops after the first touch; this sentinel check short-circuits
    // the per-event URL re-parse + full initial_* re-derivation once the bag is written.
    if (this.store.getProperty(INITIAL_PROPS_SENTINEL_KEY) !== undefined) {
      return;
    }
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
    // The `utm` toggle (E6-S5) gates ONLY the per-event campaign/click-id parse. The
    // per-session `session_entry_*` re-emit is attribution, not one of S5's five toggles —
    // it stays on.
    const enrichment = event.enrichmentProfile ?? this.enrichment;
    const attribution: NeutralProperties = {
      ...(enrichment.utm !== false ? parseCampaignParams() : {}),
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
   * internal — the WireEvent shape never reaches the neutral surface. The library-set
   * disableGeoip toggle rides here as a [WIRE] map option — never a consumer value. */
  toWireEvent(event: NeutralEvent): WireEvent {
    // A scoped context view (E6-S8) may override the geoip flag per event; absent, the
    // adapter's construction-time default applies.
    const disableGeoip = event.enrichmentProfile?.disableGeoip ?? this.disableGeoip;
    return mapEventToWire(event, { disableGeoip, token: this.apiKey });
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
  // on. The duration/id/pathname are library-computed ⇒ trusted (no allowlist gating).
  // Inherits capture()'s consent gate + bot gate + rate limiter by construction, so a
  // non-granted client mints nothing here. Idempotent via unload()'s latch (called once).
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
      internalKind: 'pageleave',
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
    // property of the same key wins. A 'hidden'-policy key (identity/session state,
    // or an unclassified reserved-prefix key — fail-safe) is excluded; an 'event'-policy
    // internal key (the membership super-prop) and every plain consumer key (policy
    // undefined) ride through. This is the #3 fix: a consumer key named `groups` is
    // policy-undefined, so it is NO LONGER blanket-stripped/renamed.
    const superProps: NeutralProperties = {};
    for (const [key, value] of Object.entries(this.store.entries())) {
      if (internalKeyPolicy(key) === 'hidden') continue;
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
    // retained id as the [WIRE] link.
    const priorDistinctId = this.identity.getDistinctId();
    const idChanged = distinctId !== priorDistinctId;
    const isAnonymous = this.identity.getIdentityState() === ANONYMOUS_IDENTITY_STATE;

    if (idChanged && isAnonymous) {
      const retainedAnonId = this.identity.merge(distinctId);
      this.capture(this.buildMergeEvent(distinctId, retainedAnonId, traits, traitsOnce));
      return;
    }

    // A new id while ALREADY identified adopts the new id (posthog registers the new id on
    // any change; only the merge is anon-gated) — no anon link, no re-merge. This adoption
    // fires even with no traits, so a subsequent capture and the traits event below both
    // attribute under the NEW id, never the prior one.
    if (idChanged) {
      this.identity.setDistinctId(distinctId);
    }

    // Nothing more to do when the caller supplied no traits — a bare same-id re-identify is
    // a no-op, and a bare id-switch only adopted the id above.
    if (traits === undefined && traitsOnce === undefined) {
      return;
    }
    // Read the distinct id AFTER any adoption so the traits event is attributed under the
    // newly-adopted id, not the prior one.
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
      internalKind: 'merge',
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

  group(groupType: string, groupKey: string, traits?: NeutralTraits): void {
    // Register the membership into the `groups` super-prop so every subsequent event carries
    // it (merged via mergeSuperProperties). Merge into the existing memberships rather than
    // replacing — a client can belong to one group per type across several group() calls.
    const existing = this.store.getProperty<NeutralProperties>(GROUPS_KEY) ?? {};
    this.register({ [GROUPS_KEY]: { ...existing, [groupType]: groupKey } });

    // Mint a group-identify event through capture() so it inherits the consent / bot / rate
    // gates and the [WIRE] token stamp. The group type/key/traits ride INSIDE properties
    // (posthog's $groupidentify nests them — the wire-mapper renames the keys, no top-level
    // lift). An absent traits bag emits no set key.
    this.capture({
      event: GROUP_IDENTIFY_EVENT,
      internalKind: 'group_identify',
      distinctId: this.identity.getDistinctId(),
      properties: {
        [GROUP_TYPE_KEY]: groupType,
        [GROUP_KEY_KEY]: groupKey,
        ...(traits !== undefined ? { [GROUP_SET_KEY]: { ...traits } } : {}),
      },
      timestamp: new Date(),
      dedupeId: generateUuidV7(),
    });
  }

  alias(): void {}

  async flush(): Promise<void> {
    // Force an immediate drain (bypassing the interval / size trigger) and resolve
    // once the POST it fires — plus any auto-flush POST still on the wire — settle.
    await this.queue.flushNow();
  }

  async shutdown(): Promise<void> {
    // Unbind the page-lifecycle listeners so a post-shutdown unload can't re-drain, and the
    // autocapture DOM listeners so a post-shutdown interaction can't mint an event, then
    // flush any remaining buffer through the normal transport.
    this.detachUnloadListeners?.();
    this.detachAutocaptureListeners?.();
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
    if (response === COOLING_OFF) {
      // The scope is inside its server cool-off, but the batch was ALREADY drained from the
      // request queue — re-hold it or it vanishes for the whole ~60s window. rehold() keeps
      // the SAME attempt (a cool-off is not a delivery failure, so it must NOT advance the
      // failure count and burn the retry/backoff budget) and re-checks after one poll tick,
      // NOT a growing exponential delay. The poller re-holds on each wake until the window
      // clears, then the next send actually delivers — one element rescheduled, no dup. Mirror
      // the held set to durable storage so a reload mid-cool-off still re-sends it.
      this.retryQueue.rehold(batch, attempt);
      this.offlineQueue.persist(this.retryQueue.snapshot());
      return;
    }
    if (response === undefined) {
      // No send happened (no target / empty) — nothing was drained's worth holding, the
      // retry queue is unchanged, so the durable mirror is too. Nothing to re-persist.
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
  // read its status. When no ingest target is configured or the batch is empty, nothing
  // is sent and `undefined` is returned (a genuine no-op — nothing was drained). When
  // the scope is inside its server cool-off window, the DISTINCT `COOLING_OFF` signal is
  // returned instead so the caller re-holds the already-drained batch rather than dropping
  // it. After a completed POST, the backend's back-pressure signal is read off the response
  // body (via the injected interpreter) and arms the affected scope's cool-off. The gzip
  // encode + its [WIRE] Content-Type/query params live in the shared encoded-post module
  // (encodeBody / postEncoded), the same core replay delivery rides — never on the neutral
  // surface.
  private async postBatch(batch: WireEvent[]): Promise<PostBatchResult> {
    // Consent backstop: a retry-queue poller wake racing a denial must not POST. The
    // same consent+consentDefault gate capture() uses is re-checked here at the wire
    // boundary, so a batch already held before the opt-out never leaves the app.
    if (this.captureSuppressed()) {
      return undefined;
    }
    const url = this.ingestUrl();
    if (url === undefined || batch.length === 0) {
      return undefined;
    }
    if (this.rateLimiter.isCoolingOff(DEFAULT_BATCH_SCOPE)) {
      return COOLING_OFF;
    }
    const json = assembleBatchBody(batch, Date.now());
    const encoded = await encodeBody(json, this.compressionEnabled);
    // The shared encode+POST core does the fetch/XHR selection, the [WIRE] compression
    // params, and the keepalive-on-small policy; the RETRY wrapper and back-pressure read
    // stay HERE (capture policy). safeFetch normalizes a fetch rejection to a status-0
    // response so a network failure flows the retryable path instead of escaping. The
    // string path rides the neutral fetch() SPI (the branch these tests intercept) via the
    // injected fetch(); the binary path goes below the seam to the direct DOM fetch.
    const response = await this.safeFetch(postEncoded(url, encoded, (u, o) => this.fetch(u, o)));
    await this.rateLimiter.interpretBackPressure(response);
    return response;
  }

  // Normalize a fetch REJECTION to a status-0 neutral response at the transport boundary.
  // Browser fetch rejects on a network failure (unlike XHR, which resolves status 0), so
  // an un-caught rejection would escape postBatch → sendBatchWithRetry and be swallowed,
  // losing the batch (never re-held / persisted). Resolving status 0 here flows the failure
  // into the existing retryable path: isRetryableStatus(0) is true, maxRetriesForStatus(0)
  // is a short budget, and the offline mirror persists it. The empty text() short-circuits
  // interpretBackPressure so a network error arms no spurious cool-off. Mirrors the
  // reference request.ts:346, which maps a rejection to statusCode:0 via the same callback.
  private async safeFetch(pending: Promise<NeutralFetchResponse>): Promise<NeutralFetchResponse> {
    try {
      return await pending;
    } catch {
      return { status: 0, text: async () => '', json: async () => ({}) };
    }
  }

  getConsentState(): ConsentState {
    return this.consent.get();
  }

  setConsentState(state: ConsentState): void {
    // Snapshot the prior decision BEFORE the durable write so the grant path below can
    // fire the memory→durable promotion exactly once (only on a real transition INTO
    // granted).
    const prior = this.consent.get();
    // Opt-out contract (E4-S3): a denial DROPS the unsent buffer without flushing —
    // events captured before the opt-out must not leave the app. optIn ('granted')
    // does NOT drop. The drop is additive to the durable consent write below. It
    // also drops the persisted offline queue, so events captured before the opt-out
    // cannot rehydrate and re-send after a reload, and DISCARDS the in-memory retry
    // queue (with its poller) so a held batch can't be re-POSTed after the denial.
    if (state === 'denied') {
      this.queue.drop();
      this.offlineQueue.drop();
      this.retryQueue.clear();
    }
    this.consent.set(state);
    // Consent-pending → grant must survive a reload: a client built before an explicit
    // grant is memory-backed (identity/super-props/session/country live only in memory),
    // so promote that in-memory state onto the durable backend the moment consent is
    // granted. Fires once (guarded on the prior decision) — a client constructed granted
    // already built the durable backend, and a repeat grant is a no-op.
    if (state === 'granted' && prior !== 'granted') {
      this.promoteToDurable();
    }
  }

  // Build the durable props backend from the RAW configured mode (NOT the memory-collapsed
  // effectiveMode) with the same cookie options the constructor used, and hand it to the
  // store, which flushes its in-memory props onto it in one write. Only reached on a real
  // transition into granted; a memory-mode client rebuilds the (still-memory) backend
  // harmlessly.
  private promoteToDurable(): void {
    const durable = buildPropsBackend(this.persistenceMode, this.memoryBackend, {
      cookieDomain: this.cookieDomain,
      crossSubdomainCookie: this.crossSubdomainCookie,
    });
    this.store.promoteBackend(durable);
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

  /** @internal The current session-linkage id the replay recorder reads so a recording
   * stitches to the same session captured events carry (E14-S3). A PURE read of the last
   * session id observed on a captured event — the SAME shared id `SessionIdManager` mints and
   * the pipeline stamps on `NeutralEvent.sessionId`, never minted by the recorder. It does NOT
   * advance the idle clock the way checkAndGetSessionId() would, because getReplayId() may be
   * called arbitrarily. undefined before the first captured event mints a session. */
  getReplaySessionId(): string | undefined {
    return this.lastSeenSessionId;
  }

  /** @internal Subscribe to session-id rotation so the replay recorder re-keys its recording
   * onto the new id. Primes the listener immediately with the current session id on subscribe
   * (how the recorder keys its FIRST segment at start()), then fires on every subsequent
   * rotation. Returns an unsubscribe closure the recorder disposes on stop()/teardown. Reuses
   * the ONE existing rotation verdict (classifySessionTransition) — no second detector, no
   * onSessionId observer on the pure SessionIdManager. NOTE: the verdict fires only on a
   * captured event (runCapturePipeline), so an idle/max-length rotation that happens while no
   * event is captured re-keys LATE — a known v1 cadence limitation (E14-S3 notes). */
  onSessionRotated(listener: (sessionId: string | undefined) => void): () => void {
    this.sessionRotatedListeners.add(listener);
    listener(this.lastSeenSessionId);
    return () => {
      this.sessionRotatedListeners.delete(listener);
    };
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
