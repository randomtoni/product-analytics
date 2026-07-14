import type { FetchLike } from '../../config';
import { joinHostPath } from '../../ingest-url';
import type {
  DefinitionSnapshot,
  FlagDefinition,
  PropertyGroup,
} from './definition-types';

// The definition poller, de-branded from posthog's node FeatureFlagsPoller load/reschedule path.
// It fetches flag DEFINITIONS (not evaluated flags) on an interval, parses them into an in-memory
// DefinitionSnapshot the evaluator reads, and exposes `isReady()` + a snapshot accessor S2 binds
// to. The only async boundary in local eval lives here (the fetch); the matcher is synchronous.
// De-branded from posthog's feature-flags.ts _loadFeatureFlags / loadFeatureFlags / updateFlagState
// / _requestFeatureFlagDefinitions.

// Adapter-internal [WIRE] definition-fetch vocabulary: the endpoint path, its query params, and the
// response keys the definitions endpoint speaks. Plain UPPER_SNAKE `*_WIRE_*` consts — the SHIPPED
// node flag convention (non-`$`; the `$`-const style is the browser package's). None of it appears
// on the neutral surface. A future backend adapter negotiating a different definition wire supplies
// its own.

// The definition-list path appended to the consumer's flag-endpoint origin.
const DEFINITIONS_ENDPOINT_WIRE_PATH = '/flags/definitions';
// The query param carrying the project token, and the flag that asks the endpoint to include the
// cohort map in the response.
const TOKEN_WIRE_QUERY = 'token';
const SEND_COHORTS_WIRE_QUERY = 'send_cohorts';
// Response keys carrying the definition list, the group-type mapping, and the cohort map.
const FLAGS_WIRE_KEY = 'flags';
const GROUP_TYPE_MAPPING_WIRE_KEY = 'group_type_mapping';
const COHORTS_WIRE_KEY = 'cohorts';

// The [WIRE] definition-fetch response the endpoint returns. Adapter-internal — never neutral
// surface.
interface DefinitionsWireResponse {
  [FLAGS_WIRE_KEY]?: FlagDefinition[];
  [GROUP_TYPE_MAPPING_WIRE_KEY]?: Record<string, string>;
  [COHORTS_WIRE_KEY]?: Record<string, PropertyGroup>;
}

// The poller's adapter-internal config. `definitionsKey` is the privileged (definition-reading)
// credential, named BY ROLE — never a vendor key name; it authorizes the definition fetch and is
// distinct from the ingest write key and the remote-eval project key. `token` is the project token
// the endpoint scopes the definitions to.
export interface DefinitionPollerConfig {
  definitionsEndpoint: string;
  definitionsKey: string;
  token: string;
  pollIntervalMs: number;
  fetch: FetchLike;
}

const EMPTY_SNAPSHOT: DefinitionSnapshot = Object.freeze({
  flags: Object.freeze([]),
  flagsByKey: Object.freeze({}),
  groupTypeMapping: Object.freeze({}),
  cohorts: Object.freeze({}),
});

export class DefinitionPoller {
  // The fetch machinery is UNDEFINED in seeded mode — the seeded poller structurally lacks the URL,
  // the privileged credential, and the fetch it would need to reach a definitions endpoint (S2's
  // structural guardrail: "no fetch, no URL, no thread" is a property of construction, not merely of
  // the start() no-op). A fetching poller sets all three; a seeded one leaves them undefined and its
  // start()/load() short-circuit before ever touching them.
  private readonly definitionsUrl: string | undefined;
  private readonly definitionsKey: string | undefined;
  private readonly pollIntervalMs: number | undefined;
  private readonly doFetch: FetchLike | undefined;
  private snapshot: DefinitionSnapshot = EMPTY_SNAPSHOT;
  private loadedSuccessfullyOnce = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  // In-flight dedup: concurrent load requests share this single promise so only one fetch is in
  // flight at a time; cleared when it settles.
  private loadingPromise: Promise<void> | undefined;
  private stopped = false;
  // Seeded mode: definitions came from config (S2), not the fetch. `start()` is a real no-op and the
  // seed is already `isReady()` from construction — the adapter reads through the same `local.poller`
  // field and cannot tell the difference.
  private readonly seeded: boolean;

  constructor(config: DefinitionPollerConfig) {
    this.definitionsUrl = resolveDefinitionsUrl(config.definitionsEndpoint, config.token);
    this.definitionsKey = config.definitionsKey;
    this.pollIntervalMs = config.pollIntervalMs;
    this.doFetch = config.fetch;
    this.seeded = false;
  }

  // Construct a SEEDED poller from a pre-lowered `DefinitionSnapshot` (S1's `lowerDefinitions`) —
  // the static-definitions self-host path (S2). Same `DefinitionPoller` type, so `local.poller`'s
  // type is unchanged and the adapter's resolve/lifecycle path is byte-for-byte unchanged. It carries
  // NO definitions endpoint / privileged credential / fetch — structurally unable to reach a remote
  // source. `isReady()` is true from construction (seed loaded, non-empty); `start()`/`stop()` are
  // real no-ops (no thread, no timer, no URL, no fetch). The private constructor above stays the
  // fetching mode; this factory is the only seeded entry.
  static seeded(snapshot: DefinitionSnapshot): DefinitionPoller {
    const poller = Object.create(DefinitionPoller.prototype) as DefinitionPoller;
    Object.assign(poller, {
      definitionsUrl: undefined,
      definitionsKey: undefined,
      pollIntervalMs: undefined,
      doFetch: undefined,
      snapshot,
      loadedSuccessfullyOnce: true,
      timer: undefined,
      loadingPromise: undefined,
      stopped: false,
      seeded: true,
    });
    return poller;
  }

  // Kick off polling: an immediate first load, then a self-rescheduling interval. Returns the
  // first-load promise so a caller can await readiness. In seeded mode this is a REAL no-op — the
  // seed is already present, so there is no thread, no URL resolution, and no fetch (the adapter's
  // constructor calls `start()` unconditionally; a seeded poller that fetched would reintroduce the
  // very remote dependency S2 bypasses).
  start(): Promise<void> {
    if (this.seeded) {
      return Promise.resolve();
    }
    return this.load();
  }

  // True once at least one successful load has parsed a non-empty definition list — S2's
  // "should I try local eval" gate.
  isReady(): boolean {
    return this.loadedSuccessfullyOnce && this.snapshot.flags.length > 0;
  }

  // The current parsed definition snapshot, read atomically by the evaluator. Before the first
  // successful load this is the frozen empty snapshot (never undefined) so a read never crashes.
  getSnapshot(): DefinitionSnapshot {
    return this.snapshot;
  }

  // Halt polling: clear the pending timer so no further loads are scheduled. Idempotent.
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  // Load definitions once, deduping a concurrent call onto the same in-flight promise. Reschedules
  // the next poll BEFORE doing the fetch work (mirroring the reference), so a slow/failed fetch
  // never stalls the interval.
  private load(): Promise<void> {
    // A seeded poller never fetches (its `start()` short-circuits); this guard makes that structural
    // even against a direct `load()` — the fetch machinery is undefined, so there is nothing to load.
    if (this.seeded) {
      return Promise.resolve();
    }
    if (this.loadingPromise !== undefined) {
      return this.loadingPromise;
    }
    this.scheduleNext();
    this.loadingPromise = this.fetchDefinitions()
      .catch(() => {
        // A failed load leaves the prior snapshot in place — never overwrite good data with an
        // error. The next scheduled poll retries.
      })
      .finally(() => {
        this.loadingPromise = undefined;
      });
    return this.loadingPromise;
  }

  private scheduleNext(): void {
    if (this.stopped) {
      return;
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.load();
    }, this.pollIntervalMs);
    // Node's timer handle carries .unref() — call it so a short-lived process (CLI/cron/test) that
    // builds a local-capable flag client isn't held open up to the poll interval by the pending
    // reschedule (mirrors batch-queue's armInterval; browser/edge setTimeout returns a bare number,
    // where the optional-chain makes this a no-op).
    this.timer?.unref?.();
  }

  private async fetchDefinitions(): Promise<void> {
    // Narrows the optional fetch machinery: it is defined only in fetching mode, and `load()` (the
    // only caller) already short-circuits in seeded mode — so this is unreachable when absent.
    if (
      this.doFetch === undefined ||
      this.definitionsUrl === undefined ||
      this.definitionsKey === undefined
    ) {
      return;
    }
    const response = await this.doFetch(this.definitionsUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.definitionsKey}`,
      },
    });
    if (response.ok === false) {
      return;
    }
    const parsed = (await response.json()) as DefinitionsWireResponse;
    const flags = parsed[FLAGS_WIRE_KEY] ?? [];
    this.snapshot = Object.freeze({
      flags,
      flagsByKey: Object.freeze(
        flags.reduce<Record<string, FlagDefinition>>((acc, flag) => {
          acc[flag.key] = flag;
          return acc;
        }, {})
      ),
      groupTypeMapping: Object.freeze({ ...(parsed[GROUP_TYPE_MAPPING_WIRE_KEY] ?? {}) }),
      cohorts: Object.freeze({ ...(parsed[COHORTS_WIRE_KEY] ?? {}) }),
    });
    this.loadedSuccessfullyOnce = true;
  }
}

// Resolve the definitions URL from the consumer's bare flag origin: append the [WIRE] definitions
// path and the token + send-cohorts query params.
function resolveDefinitionsUrl(definitionsEndpoint: string, token: string): string {
  const params = new URLSearchParams({ [TOKEN_WIRE_QUERY]: token });
  params.set(SEND_COHORTS_WIRE_QUERY, '');
  return `${joinHostPath(definitionsEndpoint, DEFINITIONS_ENDPOINT_WIRE_PATH)}?${params.toString()}`;
}
