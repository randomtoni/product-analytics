import {
  type FeatureFlagPort,
  type FlagContext,
  type FlagReason,
  type FlagSet,
  type FlagValue,
  type FlagsConfig,
  type TaxonomyShape,
} from 'analytics-kit';
import type { FetchLike } from '../config';
import {
  DefinitionPoller,
  InconclusiveMatchError,
  RequiresServerEvaluation,
  computeFlagLocally,
  type FlagDefinition,
} from './local';

// Adapter-internal [WIRE] flag-eval vocabulary: the endpoint path, request-body keys, and response
// keys this backend's flag-decision endpoint speaks. None of it appears on the neutral surface —
// the adapter maps FlagContext → this body and this response → a FlagSet. A future backend adapter
// negotiating a different flag wire supplies its own. De-branded from posthog's node evaluateFlags
// remote path (posthog-core-stateless.ts getFlags request + PostHogV2FlagsResponse).

// The flag-eval decision path appended to the consumer's flag-endpoint origin. [WIRE] — endpoint
// envelope detail, not neutral surface. A different backend points at its own host with its own path.
const FLAG_ENDPOINT_WIRE_PATH = '/flags/';

// Request-body keys the flag endpoint reads. Plain (non-`$`) wire tokens; the adapter maps the
// neutral FlagContext onto them. `token` authenticates the request in-body, mirroring the node
// capture transport's in-body auth — never an Authorization header (a backend-specific convention).
const TOKEN_WIRE_KEY = 'token';
const DISTINCT_ID_WIRE_KEY = 'distinct_id';
const GROUPS_WIRE_KEY = 'groups';
const PERSON_PROPERTIES_WIRE_KEY = 'person_properties';
const GROUP_PROPERTIES_WIRE_KEY = 'group_properties';
const FLAG_KEYS_WIRE_KEY = 'flag_keys_to_evaluate';

// Response keys carrying the resolved set. `FLAGS_WIRE_KEY` is the flag→value map; the payloads
// ride a sibling map. Eval-quality metadata the backend may also return (errors-while-computing,
// quota-limited, request-id, per-flag reason) is deliberately NOT read here — only the neutral
// degraded/reason signal reaches the FlagSet.
const FLAGS_WIRE_KEY = 'featureFlags';
const FLAG_PAYLOADS_WIRE_KEY = 'featureFlagPayloads';

// The consumer-observable reasons, mapped from the server round-trip states onto the S1-pinned
// FlagReason union. Named here for the adapter's own use — never widened.
const REASON_RESOLVED: FlagReason = 'resolved';
const REASON_BOOTSTRAP: FlagReason = 'bootstrap';
const REASON_UNRESOLVED: FlagReason = 'unresolved';

// The [WIRE] flag-eval response the endpoint returns. Adapter-internal — never neutral surface.
interface FlagWireResponse {
  [FLAGS_WIRE_KEY]?: Record<string, FlagValue>;
  [FLAG_PAYLOADS_WIRE_KEY]?: Record<string, unknown>;
}

// A resolved snapshot's backing data plus the reason every read reports. Wrapped by a FlagSet on
// each `evaluate`; the reason is uniform across a snapshot's keys (freshly resolved, bootstrap
// seed/fallback, or unresolved after a failed round-trip with no seed).
interface Snapshot {
  flags: Record<string, FlagValue>;
  payloads: Record<string, unknown>;
  reason: FlagReason;
  degraded: boolean;
}

// The adapter's local-evaluation capability, supplied by the factory ONLY when the config selected a
// local-capable adapter (a definitions endpoint + privileged credential). Absent ⇒ remote-only,
// exactly as E12 shipped. `poller` owns the only async boundary (the definition fetch); `onlyLocally`
// is the resolved effective `onlyEvaluateLocally ?? strictLocalEvaluation ?? false` — when true the
// remote fallback is suppressed and an inconclusive flag resolves to its degraded neutral state.
export interface LocalEvalCapability {
  poller: DefinitionPoller;
  onlyLocally: boolean;
}

export interface HttpFlagAdapterOptions {
  // The project key (config), sent in-body so the flag endpoint authenticates the request.
  key: string;
  // The bare flag-eval origin the round-trip POSTs to; the adapter appends its own [WIRE] flag path.
  // Optional under a local-only posture — a local-only adapter never reaches the remote path.
  flagEndpoint?: string;
  // Config-supplied bootstrap seed (SSR request-scoped flag data). Server path is round-trip-primary,
  // so this is a minimal seed/fallback served only when a round-trip fails — never a flash guard.
  bootstrap?: FlagsConfig['bootstrap'];
  fetch: FetchLike;
  // Present ⇒ the adapter is local-capable: a local-first strategy branch runs inside `evaluate`,
  // falling back to the remote round-trip for flags it can't resolve locally (unless `onlyLocally`).
  local?: LocalEvalCapability;
}

// Build a FlagSet snapshot over the given resolved data. The reads are pure synchronous lookups off
// the frozen backing maps; `reason` reports the same value for every present key (the snapshot-level
// state). `isEnabled` collapses a missing flag to false; `getFlag`/`getPayload` distinguish missing
// (undefined) from disabled (false) — the neutralized node snapshot read contract. The taxonomy
// generic carries so a typed consumer's `getFlag`/`getPayload` reads narrow.
function buildFlagSet<TX extends TaxonomyShape>(snapshot: Snapshot): FlagSet<TX> {
  const { flags, payloads, reason, degraded } = snapshot;
  return Object.freeze({
    isEnabled: (key: string): boolean => flags[key] !== undefined && flags[key] !== false,
    getFlag: (key: string): FlagValue | undefined => flags[key],
    getPayload: (key: string): unknown => payloads[key],
    getAll: (): Record<string, FlagValue> => ({ ...flags }),
    degraded,
    reason: (key: string): FlagReason | undefined =>
      flags[key] !== undefined || payloads[key] !== undefined ? reason : undefined,
  }) as FlagSet<TX>;
}

// The node/server remote-eval feature-flag adapter. Satisfies the frozen S1 FeatureFlagPort with an
// entirely different implementation from the browser: no persistence, no init fetch, no cache shared
// across actors. Each `evaluate` is an independent per-call round-trip for its own `distinctId` (a
// stateless server has no ambient actor), so a wire body is NEVER shared across calls with differing
// contexts. `distinctId` is required and validated; `onChange` fires ONCE with the resolved set on
// the first `evaluate` (the stateless-server degenerate cardinality), then never again.
export class HttpFlagAdapter<TX extends TaxonomyShape> implements FeatureFlagPort<TX> {
  private readonly apiKey: string;
  private readonly flagUrl: string | undefined;
  private readonly bootstrap: Snapshot | undefined;
  private readonly doFetch: FetchLike;
  private readonly local: LocalEvalCapability | undefined;
  private readonly listeners = new Set<(set: FlagSet<TX>) => void>();
  // The once-fire guard: a stateless server has no push-based flag stream, so `onChange` fires on
  // the FIRST resolved snapshot and never again. Set the first time an `evaluate` settles.
  private fired = false;
  private firstSet: FlagSet<TX> | undefined;

  constructor(options: HttpFlagAdapterOptions) {
    this.apiKey = options.key;
    this.flagUrl =
      options.flagEndpoint !== undefined && options.flagEndpoint.trim() !== ''
        ? resolveFlagUrl(options.flagEndpoint)
        : undefined;
    this.bootstrap = seedBootstrap(options.bootstrap);
    this.doFetch = options.fetch;
    this.local = options.local;
    // Fire-and-forget the first definition load: local eval must not put a definitions round-trip on
    // the critical path of the first `evaluate` (the reference starts the poller in its constructor).
    // `isReady()` gates the local branch until the load lands; until then `evaluate` falls to remote.
    if (this.local !== undefined) {
      void this.local.poller.start();
    }
  }

  async evaluate(context?: FlagContext): Promise<FlagSet<TX>> {
    // The per-call `distinctId` is the ONLY eval-identity source on the server — no persisted or
    // ambient actor (the server half of the E4 sessionId asymmetry). Absence is a caller error, not
    // a degraded eval: throw a clear NEUTRAL error before any network, and fire no listener.
    if (context?.distinctId === undefined || context.distinctId === '') {
      throw new Error('analytics: distinctId is required to evaluate flags on the server');
    }
    const snapshot = await this.resolve(context);
    const set = buildFlagSet<TX>(snapshot);
    this.fireOnce(set);
    return set;
  }

  // Halt the definition poller so no further loads are scheduled (no-op when remote-only). Idempotent
  // — the local machinery's timer is the only leakable resource the adapter owns.
  stop(): void {
    this.local?.poller.stop();
  }

  // Resolve a snapshot for THIS context via the local-first strategy branch when local-capable and
  // the poller is ready; otherwise the pure remote path E12 shipped. This is the ONLY place the
  // strategy is decided — `evaluate`'s signature and the returned `FlagSet` are indistinguishable
  // across strategies (same snapshot shape, same neutral `reason`/`degraded`).
  private async resolve(context: FlagContext): Promise<Snapshot> {
    const local = this.local;
    if (local === undefined || !local.poller.isReady()) {
      // Not local-capable, or definitions haven't loaded yet. Under local-only there is no remote
      // path — resolve to the neutral degraded-empty snapshot; otherwise the shipped remote path
      // with the ORIGINAL untouched context (every requested flag goes remote, nothing narrowed).
      if (local?.onlyLocally === true) {
        return { flags: {}, payloads: {}, reason: REASON_UNRESOLVED, degraded: true };
      }
      return this.roundTrip(context);
    }
    return this.resolveLocalFirst(context, local);
  }

  // The local-first strategy: evaluate each requested flag in-process, collect the ones that can't be
  // decided locally, and (unless local-only) layer ONE remote round-trip over just those keys. The
  // merge is per-flag on the maps, snapshot-uniform on the reason — locally-resolved keys are kept,
  // remote values fill only the still-unresolved ones. A partial failure degrades the whole snapshot
  // (snapshot-uniform reason), so a fallback flag that couldn't resolve reads like a remote failure.
  private async resolveLocalFirst(
    context: FlagContext,
    local: LocalEvalCapability
  ): Promise<Snapshot> {
    const snapshot = local.poller.getSnapshot();
    const definitions =
      context.flagKeys !== undefined
        ? context.flagKeys.map((key) => snapshot.flagsByKey[key]).filter(isDefined)
        : snapshot.flags;

    const flags: Record<string, FlagValue> = {};
    const payloads: Record<string, unknown> = {};
    const fallbackKeys: string[] = [];

    for (const definition of definitions) {
      try {
        const value = computeFlagLocally(definition, context, snapshot);
        flags[definition.key] = value;
        const payload = resolveLocalPayload(definition, value);
        if (payload !== undefined) {
          payloads[definition.key] = payload;
        }
      } catch (err) {
        if (err instanceof InconclusiveMatchError || err instanceof RequiresServerEvaluation) {
          fallbackKeys.push(definition.key);
        } else {
          throw err;
        }
      }
    }

    if (fallbackKeys.length === 0) {
      return { flags, payloads, reason: REASON_RESOLVED, degraded: false };
    }
    if (local.onlyLocally) {
      // Local-only suppresses the fallback: the inconclusive keys stay absent (their read collapses to
      // undefined/false), and the snapshot degrades because a requested flag could not be resolved.
      return { flags, payloads, reason: REASON_UNRESOLVED, degraded: true };
    }
    // Fall back to E12's SHIPPED remote path for just the unresolved keys — one round-trip, narrowed
    // to the fallback set so the wire body only asks for what local eval couldn't decide.
    const remote = await this.roundTrip({ ...context, flagKeys: fallbackKeys });
    return {
      flags: { ...flags, ...remote.flags },
      payloads: { ...payloads, ...remote.payloads },
      reason: remote.reason,
      degraded: remote.degraded,
    };
  }

  onChange(listener: (set: FlagSet<TX>) => void): () => void {
    // A stateless server fires once, on the first resolved set. A listener registered AFTER that
    // fire still receives the resolved set immediately (it missed the single fire); one registered
    // before is fired when the first `evaluate` settles. Either way each listener sees the set
    // exactly once — the degenerate cardinality of the browser's re-firing signature.
    if (this.fired && this.firstSet !== undefined) {
      listener(this.firstSet);
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Fire every registered listener exactly once, on the first resolved snapshot; subsequent
  // `evaluate` calls (different actors, fresh round-trips) do NOT re-fire — the server contract.
  private fireOnce(set: FlagSet<TX>): void {
    if (this.fired) {
      return;
    }
    this.fired = true;
    this.firstSet = set;
    for (const listener of this.listeners) {
      listener(set);
    }
    this.listeners.clear();
  }

  // One independent round-trip for THIS context's actor. Success ⇒ a freshly resolved snapshot; a
  // failed/aborted round-trip degrades to the bootstrap seed (marked 'stale') when one is supplied,
  // else the seam's 'unresolved' empty set — the neutral degradation signal. Vendor eval-quality
  // fields on the response are never read.
  private async roundTrip(context: FlagContext): Promise<Snapshot> {
    // No remote endpoint configured (a local-only posture) ⇒ the remote path has nowhere to go;
    // degrade to the neutral empty/seed snapshot rather than fetch. Reached only defensively — the
    // strategy branch never routes to the remote path under local-only.
    const resolved = this.flagUrl !== undefined ? await this.fetchFlags(this.flagUrl, context) : undefined;
    if (resolved !== undefined) {
      return { ...resolved, reason: REASON_RESOLVED, degraded: false };
    }
    if (this.bootstrap !== undefined) {
      return { ...this.bootstrap, reason: 'stale', degraded: true };
    }
    return { flags: {}, payloads: {}, reason: REASON_UNRESOLVED, degraded: true };
  }

  // POST the [WIRE] flag-eval body and parse the response into resolved flags + payloads. Returns
  // undefined on a non-2xx status or a network failure — the caller maps that onto the neutral
  // degradation. The body carries THIS call's context; nothing is shared with any other call.
  private async fetchFlags(
    flagUrl: string,
    context: FlagContext
  ): Promise<{ flags: Record<string, FlagValue>; payloads: Record<string, unknown> } | undefined> {
    try {
      const response = await this.doFetch(flagUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildWireBody(context)),
      });
      if (response.ok === false) {
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

  // Map the neutral FlagContext onto the adapter-internal [WIRE] request body for THIS actor.
  // `distinctId` is guaranteed present (validated in `evaluate`); the rest ride only when supplied.
  private buildWireBody(context: FlagContext): Record<string, unknown> {
    const body: Record<string, unknown> = {
      [TOKEN_WIRE_KEY]: this.apiKey,
      [DISTINCT_ID_WIRE_KEY]: context.distinctId,
    };
    if (context.groups !== undefined) {
      body[GROUPS_WIRE_KEY] = context.groups;
    }
    if (context.personProperties !== undefined) {
      body[PERSON_PROPERTIES_WIRE_KEY] = context.personProperties;
    }
    if (context.groupProperties !== undefined) {
      body[GROUP_PROPERTIES_WIRE_KEY] = context.groupProperties;
    }
    if (context.flagKeys !== undefined) {
      body[FLAG_KEYS_WIRE_KEY] = context.flagKeys;
    }
    return body;
  }
}

// Narrow undefined out of a mapped definition lookup (a requested flagKey with no local definition
// drops out — it never becomes a fallback key on its own).
function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

// Resolve the payload for a locally-resolved flag, keyed by the stringified resolved value on the
// definition's payload map — the local analog of the remote path's `featureFlagPayloads`, so a
// locally-resolved flag carries its payload identically. A `false` (or absent) result carries no
// payload; a string payload is JSON-parsed (raw string on failure) so the local shape matches what a
// remote response would deliver. Returns undefined when there is no payload (never null — the read
// surface reports a missing key as undefined uniformly across strategies).
// De-branded from posthog's feature-flags.ts getFeatureFlagPayload.
function resolveLocalPayload(definition: FlagDefinition, value: FlagValue): unknown {
  if (value === false) {
    return undefined;
  }
  const raw = definition.filters?.payloads?.[String(value)];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

// Seed a snapshot from config bootstrap: a resolved-shaped snapshot read 'bootstrap' (not degraded —
// a real, intentional set) used as the server round-trip's fallback. undefined when no bootstrap is
// supplied. The `reason` set here is only the seed identity; `roundTrip` restamps it to 'stale' when
// it actually serves the seed after a failed round-trip.
function seedBootstrap(bootstrap: FlagsConfig['bootstrap']): Snapshot | undefined {
  if (bootstrap === undefined) {
    return undefined;
  }
  return {
    flags: { ...(bootstrap.flags ?? {}) },
    payloads: { ...(bootstrap.payloads ?? {}) },
    reason: REASON_BOOTSTRAP,
    degraded: false,
  };
}

// Resolve the flag-eval URL from the consumer's bare flag origin, appending the adapter's own [WIRE]
// path. The factory only constructs this adapter when a non-empty endpoint is configured, so the
// origin is present here.
function resolveFlagUrl(flagEndpoint: string): string {
  const host = flagEndpoint.trim().replace(/\/+$/, '');
  return `${host}${FLAG_ENDPOINT_WIRE_PATH}`;
}
