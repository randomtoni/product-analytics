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
  private readonly definitionsUrl: string;
  private readonly definitionsKey: string;
  private readonly pollIntervalMs: number;
  private readonly doFetch: FetchLike;
  private snapshot: DefinitionSnapshot = EMPTY_SNAPSHOT;
  private loadedSuccessfullyOnce = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  // In-flight dedup: concurrent load requests share this single promise so only one fetch is in
  // flight at a time; cleared when it settles.
  private loadingPromise: Promise<void> | undefined;
  private stopped = false;

  constructor(config: DefinitionPollerConfig) {
    this.definitionsUrl = resolveDefinitionsUrl(config.definitionsEndpoint, config.token);
    this.definitionsKey = config.definitionsKey;
    this.pollIntervalMs = config.pollIntervalMs;
    this.doFetch = config.fetch;
  }

  // Kick off polling: an immediate first load, then a self-rescheduling interval. Returns the
  // first-load promise so a caller can await readiness.
  start(): Promise<void> {
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
