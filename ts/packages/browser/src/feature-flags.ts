import {
  buildFlagSet,
  emptyFlagSet,
  seedBootstrap,
  type FeatureFlagPort,
  type FlagContext,
  type FlagEvaluateOptions,
  type FlagReason,
  type FlagSet,
  type FlagSnapshot,
  type FlagValue,
  type FlagsConfig,
  type NeutralFetchResponse,
  type DefaultTaxonomyShape,
  type TaxonomyShape,
} from '@randomtoni/analytics-kit';
import { joinIngestUrl } from './ingest-url';

// Adapter-internal [WIRE] flag-eval vocabulary: the endpoint path, request-body keys, and
// response keys this backend's flag endpoint speaks. None of it appears on the neutral
// surface — the adapter maps FlagContext → this body and this response → a FlagSet. A future
// backend adapter negotiating a different flag wire supplies its own. De-branded from posthog's
// posthog-featureflags.ts flag-eval request/response.

// The flag-eval path appended to the consumer's ingest origin. [WIRE] — endpoint envelope
// detail, not neutral surface. A different backend points at its own host with its own path.
const FLAG_ENDPOINT_WIRE_PATH = '/flags/';

// Request-body keys the flag endpoint reads. Plain (non-`$`) wire tokens; the adapter maps
// the neutral FlagContext onto them. `token` authenticates the request, mirroring the capture
// transport's in-body auth.
const TOKEN_WIRE_KEY = 'token';
const DISTINCT_ID_WIRE_KEY = 'distinct_id';
const GROUPS_WIRE_KEY = 'groups';
const PERSON_PROPERTIES_WIRE_KEY = 'person_properties';
const GROUP_PROPERTIES_WIRE_KEY = 'group_properties';
const FLAG_KEYS_WIRE_KEY = 'flag_keys';

// Response keys carrying the resolved set. `FLAGS_WIRE_KEY` is the flag→value map; the
// payloads ride a sibling map. Eval-quality metadata the backend may also return
// (errors-while-computing, quota-limited, request-id, per-flag reason) is deliberately NOT
// read here — only the neutral degraded/reason signal reaches the FlagSet.
const FLAGS_WIRE_KEY = 'featureFlags';
const FLAG_PAYLOADS_WIRE_KEY = 'featureFlagPayloads';

// The consumer-observable reasons, mapped from the browser's real fetch states onto the
// S1-pinned FlagReason union. Named here for the adapter's own use — never widened.
const REASON_RESOLVED: FlagReason = 'resolved';
const REASON_STALE: FlagReason = 'stale';

// The [WIRE] flag-eval response the endpoint returns. Adapter-internal — never neutral surface.
interface FlagWireResponse {
  [FLAGS_WIRE_KEY]?: Record<string, FlagValue>;
  [FLAG_PAYLOADS_WIRE_KEY]?: Record<string, unknown>;
}

export interface FlagAdapterOptions {
  // The ingest auth key (config), sent in-body so the flag endpoint authenticates the request.
  key: string;
  // The bare ingest origin the flag-eval request POSTs to; the adapter appends its own [WIRE]
  // flag path. undefined ⇒ no flag endpoint, so evaluate never fetches (bootstrap/empty only).
  ingestHost?: string;
  // Config-supplied bootstrap seed (server-rendered flag data), consumed synchronously at
  // construction to kill the flash-of-wrong-variant.
  bootstrap?: FlagsConfig['bootstrap'];
  // Single-sourced browser identity: the flag adapter fills a missing FlagContext.distinctId
  // from here rather than minting or caching a second id.
  getDistinctId: () => string;
  // The HTTP verb — reuses the browser adapter's transport SPI so all network crosses one seam.
  fetch: (url: string, options: FlagFetchOptions) => Promise<NeutralFetchResponse>;
}

// The subset of the browser fetch SPI the flag POST needs. Structural (and `method` literal
// 'POST') so it satisfies the adapter's NeutralFetchOptions without importing that type here —
// the flag module stays decoupled from the capture-transport surface.
export interface FlagFetchOptions {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

// The browser remote-eval feature-flag adapter. Satisfies the frozen S1 FeatureFlagPort: an
// async `evaluate` resolving an immutable FlagSet read synchronously off a cache, plus a
// re-firing `onChange` listener. Bootstrap seeds the cache synchronously at construction; a
// network fetch refreshes it; a failed refresh serves the prior set as 'stale', or the seam's
// canonical empty snapshot as 'unresolved' when nothing is cached.
export class FlagClient<TX extends TaxonomyShape = DefaultTaxonomyShape>
  implements FeatureFlagPort<TX>
{
  private readonly apiKey: string;
  private readonly flagUrl: string | undefined;
  private readonly getDistinctId: () => string;
  private readonly doFetch: (url: string, options: FlagFetchOptions) => Promise<NeutralFetchResponse>;
  private readonly listeners = new Set<(set: FlagSet<TX>) => void>();
  // The resolved snapshot, seeded from bootstrap at construction and replaced on each successful
  // fetch. undefined only when no bootstrap was supplied and no fetch has yet resolved.
  private cache: FlagSnapshot | undefined;
  // Coalesces concurrent evaluate() calls onto one in-flight fetch so a burst of reads issues a
  // single request; cleared when the fetch settles.
  private inFlight: Promise<void> | undefined;

  constructor(options: FlagAdapterOptions) {
    this.apiKey = options.key;
    this.flagUrl = resolveFlagUrl(options.ingestHost);
    this.getDistinctId = options.getDistinctId;
    this.doFetch = options.fetch;
    // Bootstrap seeding is the whole point: land the config set in the cache NOW, before any
    // evaluate() could run, so the first synchronous read returns the bootstrap set with
    // reason 'bootstrap' (not the network set, not empty).
    this.cache = seedBootstrap(options.bootstrap);
  }

  async evaluate(context?: FlagContext, options?: FlagEvaluateOptions): Promise<FlagSet<TX>> {
    // A forced refresh is an explicit request for fresh data for THIS context — await a fetch
    // that carries the new context (never a stale in-flight one built from an earlier context)
    // and return the resolved (or stale-on-failure) result, re-firing onChange. This is the
    // browser's `reload`, folded into evaluate per S1.
    if (options?.refresh === true) {
      await this.refresh(context, true);
      return this.currentSet();
    }
    // An already-resolved cache is served synchronously — the snapshot model's point.
    if (this.cache?.reason === REASON_RESOLVED) {
      return this.currentSet();
    }
    // A bootstrap-seeded cache (not yet network-resolved) is served IMMEDIATELY without waiting on
    // the network — the flash-of-wrong-variant only exists client-side. A background fetch still
    // runs and fires onChange with the network set when it arrives.
    if (this.cache !== undefined) {
      void this.refresh(context, false);
      return this.currentSet();
    }
    // No cached set (no bootstrap, nothing resolved yet): there is nothing to serve
    // synchronously, so await the fetch and return whatever it yields (resolved, or the seam's
    // 'unresolved' empty snapshot on failure).
    await this.refresh(context, false);
    return this.currentSet();
  }

  onChange(listener: (set: FlagSet<TX>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Fetch the flag set and replace the cache, then fire listeners. A failed/aborted fetch keeps
  // the prior set (marked 'stale') or leaves the cache empty — `currentSet` maps either onto the
  // neutral degradation signal.
  //
  // Coalescing is deliberately conditional on `force`:
  //  - A NON-forced caller (the first-load / bootstrap-background fetch) shares an already
  //    in-flight request. This is safe ONLY because the browser single-sources `distinctId` from
  //    one identity, so a shared wire body is correct here. A SERVER target (S3/S4) MUST NOT copy
  //    this: server `distinctId`/props vary per `evaluate` call, so sharing one caller's wire body
  //    would answer a later caller against the wrong actor. Server adapters fetch per call.
  //  - A FORCED refresh (`evaluate(ctx, { refresh: true })`) is an explicit "fresh data for THIS
  //    context" request, so it must NEVER coalesce onto a stale in-flight fetch built from an
  //    earlier context. When a fetch is already running, we chain a guaranteed follow-up fetch for
  //    the new context after it settles (mirroring the reference's `_additionalReloadRequested`
  //    follow-up), so the forced refresh always results in a wire fetch carrying the new context.
  private async refresh(context: FlagContext | undefined, force: boolean): Promise<void> {
    if (this.inFlight !== undefined) {
      if (!force) {
        return this.inFlight;
      }
      // A fetch is already in flight but the caller demands fresh data for this context: run the
      // new fetch AFTER the current one settles (avoiding two concurrent commits racing the cache),
      // and adopt its promise as the in-flight so a later caller coalesces onto the latest.
      const chained = this.inFlight
        .catch(() => undefined)
        .then(() => this.fetchAndCommit(context))
        .finally(() => {
          if (this.inFlight === chained) {
            this.inFlight = undefined;
          }
        });
      this.inFlight = chained;
      return chained;
    }
    const started = this.fetchAndCommit(context).finally(() => {
      if (this.inFlight === started) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = started;
    return started;
  }

  private async fetchAndCommit(context?: FlagContext): Promise<void> {
    const resolved = await this.fetchFlags(context);
    if (resolved === undefined) {
      // A failed refresh: degrade the prior set to 'stale' if one exists; otherwise the cache
      // stays undefined and currentSet serves the seam's 'unresolved' empty snapshot.
      if (this.cache !== undefined) {
        this.cache = { ...this.cache, reason: REASON_STALE, degraded: true };
      }
    } else {
      this.cache = { ...resolved, reason: REASON_RESOLVED, degraded: false };
    }
    this.fireListeners();
  }

  // POST the [WIRE] flag-eval body and parse the response into resolved flags + payloads.
  // Returns undefined on no endpoint, a non-2xx status, or a network failure — the caller maps
  // that onto the stale/unresolved degradation. Maps FlagContext → the [WIRE] request body;
  // distinctId falls back to the single-sourced browser identity when the caller omits it.
  private async fetchFlags(
    context?: FlagContext
  ): Promise<{ flags: Record<string, FlagValue>; payloads: Record<string, unknown> } | undefined> {
    if (this.flagUrl === undefined) {
      return undefined;
    }
    try {
      const response = await this.doFetch(this.flagUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildWireBody(context)),
      });
      if (response.status < 200 || response.status >= 300) {
        return undefined;
      }
      const parsed = (await response.json()) as FlagWireResponse;
      return {
        flags: parsed[FLAGS_WIRE_KEY] ?? {},
        payloads: parsed[FLAG_PAYLOADS_WIRE_KEY] ?? {},
      };
    } catch {
      return undefined;
    }
  }

  // Map the neutral FlagContext onto the adapter-internal [WIRE] request body. distinctId is
  // single-sourced: the caller's explicit value overrides, otherwise the browser identity fills
  // it (the browser half of the E4 sessionId asymmetry — no fake ambient actor).
  private buildWireBody(context?: FlagContext): Record<string, unknown> {
    const distinctId = context?.distinctId ?? this.getDistinctId();
    const body: Record<string, unknown> = {
      [TOKEN_WIRE_KEY]: this.apiKey,
      [DISTINCT_ID_WIRE_KEY]: distinctId,
    };
    if (context?.groups !== undefined) {
      body[GROUPS_WIRE_KEY] = context.groups;
    }
    if (context?.personProperties !== undefined) {
      body[PERSON_PROPERTIES_WIRE_KEY] = context.personProperties;
    }
    if (context?.groupProperties !== undefined) {
      body[GROUP_PROPERTIES_WIRE_KEY] = context.groupProperties;
    }
    if (context?.flagKeys !== undefined) {
      body[FLAG_KEYS_WIRE_KEY] = context.flagKeys;
    }
    return body;
  }

  // The FlagSet for the current cache: the resolved/bootstrap/stale snapshot when one exists, or
  // the seam's canonical 'unresolved' empty snapshot (never a hand-rolled second empty — S5 reads
  // the same null-object) when nothing has resolved and no bootstrap was supplied.
  private currentSet(): FlagSet<TX> {
    if (this.cache === undefined) {
      return emptyFlagSet<TX>();
    }
    return buildFlagSet<TX>(this.cache);
  }

  private fireListeners(): void {
    const set = this.currentSet();
    for (const listener of this.listeners) {
      listener(set);
    }
  }
}

// Resolve the flag-eval URL from the consumer's bare ingest origin, appending the adapter's own
// [WIRE] flag path via the package's single host-join helper (the same join capture + replay use,
// so the browser has ONE host-join). undefined when no host is configured — the adapter then never
// fetches.
function resolveFlagUrl(ingestHost?: string): string | undefined {
  return joinIngestUrl(ingestHost, FLAG_ENDPOINT_WIRE_PATH);
}
