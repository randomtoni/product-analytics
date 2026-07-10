import { createAnalytics } from '@analytics-kit/browser';
import type { RootAnalytics } from '@analytics-kit/browser';
import type {
  FeatureFlagPort,
  FlagReason,
  FlagSet,
  FlagValue,
  ShapeOf,
  TaxonomyShape,
} from 'analytics-kit';
import { fernlyTaxonomy, type FernlyTaxonomy } from './taxonomy';

export type FernlyFlagShape = ShapeOf<FernlyTaxonomy['decl']>;

// The bootstrap set Fernly ships as config (server-rendered flag data). Neutral field names.
export const FERNLY_FLAG_BOOTSTRAP = {
  flags: { review_ai_summary: 'concise', bulk_review_actions: true } as Record<string, FlagValue>,
  payloads: { review_ai_summary: { model: 'draft-1', maxTokens: 256 } } as Record<string, unknown>,
};

// A deferred whose resolve is externally held — lets a test resolve the flag fetch on demand so
// the bootstrap-before-fetch and network-arrival halves are proven deterministically rather than
// on a timer.
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// A minimal fetch Response stub carrying just the fields the flag adapter reads (status + json()).
function jsonResponse(body: unknown): { status: number; json: () => Promise<unknown> } {
  return { status: 200, json: async () => body };
}

// The network flag set the stubbed endpoint returns once the deferred resolves — a DIFFERENT set
// from bootstrap, so the promotion from 'bootstrap' to 'resolved' is observable.
export const FERNLY_FLAG_NETWORK_WIRE = {
  featureFlags: { review_ai_summary: 'detailed', bulk_review_actions: false },
  featureFlagPayloads: { review_ai_summary: { model: 'review-9', maxTokens: 1024 } },
};

export interface FernlyFlagClientHandle {
  // The wired client — its `flags` slot is the real browser FlagClient (the shipped provider slot
  // is the untyped FeatureFlagPort by design; taxonomy-typed narrowing rides createFlagClient /
  // the React hook, not this slot).
  analytics: RootAnalytics;
  // Resolve the pending flag fetch with the network set — promotes the cache to 'resolved'.
  resolveFetch: () => void;
  // How many times the stubbed flag endpoint was hit.
  fetchCount: () => number;
}

// Build a REAL browser-adapter-backed client (config.key set ⇒ provider.flags is the real
// FlagClient) with a deterministic, deferred flag fetch. This exercises the shipped browser flag
// adapter end-to-end (attachFlags → FlagClient → adapter.fetch → global fetch), NOT a hand-rolled
// fake. The global fetch is stubbed to the flag endpoint; the caller resolves it on demand.
export function createFernlyFlagClient(
  originalFetch: typeof globalThis.fetch,
  installStub: (stub: typeof globalThis.fetch) => void
): FernlyFlagClientHandle {
  const gate = createDeferred<void>();
  let count = 0;
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    // Deliberately mirrors the browser adapter's wire flag-endpoint path (FLAG_ENDPOINT_WIRE_PATH).
    if (url.includes('/flags/')) {
      count += 1;
      await gate.promise;
      return jsonResponse(FERNLY_FLAG_NETWORK_WIRE) as unknown as Response;
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
  installStub(stub);

  const analytics = createAnalytics({
    key: 'fernly-flag-key',
    ingestHost: 'https://ingest.fernly.example',
    taxonomy: fernlyTaxonomy,
    flags: { bootstrap: FERNLY_FLAG_BOOTSTRAP },
  });

  return {
    analytics,
    resolveFetch: () => gate.resolve(),
    fetchCount: () => count,
  };
}

// An in-example fake FeatureFlagPort over a canned snapshot — the bar-A swap target. A consumer's
// flag reads are byte-identical whether they run against this fake or the real FlagClient; this
// fake exists ONLY to prove that swap-equivalence (it does no network, no bootstrap timing).
// Generic over the taxonomy shape so it can swap for either the untyped browser provider slot or
// the taxonomy-typed node createFlagClient result.
export function createFakeFlagPort<TX extends TaxonomyShape>(
  flags: Record<string, FlagValue>,
  payloads: Record<string, unknown> = {}
): FeatureFlagPort<TX> {
  const snapshot: FlagSet<TX> = Object.freeze({
    isEnabled: (key: string) => flags[key] !== undefined && flags[key] !== false,
    getFlag: (key: string) => flags[key],
    getPayload: (key: string) => payloads[key],
    getAll: () => ({ ...flags }),
    degraded: false,
    reason: (key: string): FlagReason | undefined =>
      flags[key] !== undefined || payloads[key] !== undefined ? 'resolved' : undefined,
  }) as FlagSet<TX>;
  const listeners = new Set<(set: FlagSet<TX>) => void>();
  return {
    evaluate: async () => snapshot,
    onChange: (listener) => {
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
