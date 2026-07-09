import type { QueryColumn, QueryResult, TaxonomyShape } from 'analytics-kit';
import type { FetchLike } from '../config';
import type {
  AnalyticsQueryClient,
  Aggregation,
  Duration,
  FunnelSpec,
  Granularity,
  RetentionSpec,
  TrendSpec,
  UniqueCountSpec,
} from './query-client';

// --- Adapter-internal wire vocabulary (NON-EXPORTED). ---
// Everything below models the backend's HTTP query wire and NEVER leaves this module:
// the `kind` discriminators, the field casing quirks, the `math` enum, and the response
// envelope are all confined here. The exported surface (`AnalyticsQueryClient`, the spec
// types, `QueryResult`) carries business primitives only — no wire vocabulary escapes.

type Interval = 'hour' | 'day' | 'week' | 'month';
type Math = 'total' | 'dau';
type RetentionPeriod = 'Day' | 'Week' | 'Month';
type FunnelWindowUnit = 'minute' | 'hour' | 'day' | 'week' | 'month';

interface WireDateRange {
  date_from: string;
}

interface WireBreakdownFilter {
  breakdown: string;
  breakdown_type: 'event';
}

interface WireEventsNode {
  kind: 'EventsNode';
  event: string;
  math?: Math;
}

interface WireTrendsQuery {
  kind: 'TrendsQuery';
  series: WireEventsNode[];
  interval: Interval;
  dateRange: WireDateRange;
  breakdownFilter?: WireBreakdownFilter;
}

interface WireFunnelsQuery {
  kind: 'FunnelsQuery';
  series: WireEventsNode[];
  funnelsFilter: {
    funnelWindowInterval: number;
    funnelWindowIntervalUnit: FunnelWindowUnit;
  };
  breakdownFilter?: WireBreakdownFilter;
}

interface WireRetentionEntity {
  id: string;
  name: string;
  type: 'events';
  kind: 'EventsNode';
}

interface WireRetentionQuery {
  kind: 'RetentionQuery';
  retentionFilter: {
    targetEntity: WireRetentionEntity;
    returningEntity: WireRetentionEntity;
    period: RetentionPeriod;
    totalIntervals: number;
  };
  breakdownFilter?: WireBreakdownFilter;
}

interface WireHogQLQuery {
  kind: 'HogQLQuery';
  query: string;
}

type WireQueryNode =
  | WireTrendsQuery
  | WireFunnelsQuery
  | WireRetentionQuery
  | WireHogQLQuery;

// The sync response envelope. `results` is plural + required; `columns`/`types` are
// separate parallel optional arrays; `is_cached` is present ONLY on the cached variant.
interface WireResultBearing {
  results: unknown[];
  columns?: string[];
  types?: string[];
}

interface WireSyncEnvelope extends WireResultBearing {
  hogql?: string;
  is_cached?: boolean;
}

// The async status envelope: the SAME `{ query_status }` key carries both the pending
// state and — once `complete` flips true — the nested completed `results`. `results`
// nests ONE level deeper than the sync path and carries no sibling columns/types here.
// Detection MUST key on `complete === false` (or HTTP 202), never on mere presence of
// `query_status` (the completed poll response still carries the key).
interface WireQueryStatus extends WireResultBearing {
  id: string;
  complete?: boolean;
  error?: boolean;
  error_message?: string;
  is_cached?: boolean;
}

interface WireAsyncEnvelope {
  query_status: WireQueryStatus;
}

// Either the inline sync envelope OR the async status envelope — the POST may return
// either, and the adapter branches on which by inspecting `query_status.complete`.
type WirePostResponse = WireSyncEnvelope & Partial<WireAsyncEnvelope>;

const QUERY_PATH_TEMPLATE = (projectId: string): string =>
  `/api/projects/${projectId}/query/`;

const STATUS_ACCEPTED = 202;

// Async-request posture: ALWAYS-ASYNC. Every POST carries `refresh: 'async'`, so the
// backend runs long-window funnel/retention/trend snapshots off-thread and hands back a
// pollable status; short queries still complete inline (no `query_status.complete: false`)
// and take the sync branch unchanged. A single posture keeps one code path and matches a
// snapshot read client's large-window workload. The value is adapter-internal config.
const ASYNC_REFRESH = 'async';

// Bounded backoff-aware poll budget. Borrows the SHAPE of E5's browser backoff
// (base * 2**n, capped) but is adapter-local — a query POLL (waiting for a long-running
// query to finish) is a distinct concern from a transport RETRY, so it lives here, not in
// send-batch (fixed-delay) nor cross-package-coupled to the browser retry queue.
const POLL_BASE_MS = 250;
const POLL_MAX_DELAY_MS = 5000;
const POLL_MAX_ATTEMPTS = 20;

function pollDelay(attempt: number): number {
  return Math.min(POLL_MAX_DELAY_MS, POLL_BASE_MS * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const INTERVAL_FOR_UNIT: Record<Duration['unit'], Interval> = {
  minute: 'hour',
  hour: 'hour',
  day: 'day',
  week: 'week',
  month: 'month',
};

const MATH_FOR_AGGREGATION: Record<Aggregation, Math> = {
  total: 'total',
  unique: 'dau',
  dau: 'dau',
};

const RETENTION_PERIOD_FOR_GRANULARITY: Record<Granularity, RetentionPeriod> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
};

function relativeDateFrom(window: Duration): string {
  const unitChar: Record<Duration['unit'], string> = {
    minute: 'm',
    hour: 'h',
    day: 'd',
    week: 'w',
    month: 'M',
  };
  return `-${window.value}${unitChar[window.unit]}`;
}

function eventBreakdown(breakdown: string | undefined): WireBreakdownFilter | undefined {
  return breakdown === undefined
    ? undefined
    : { breakdown, breakdown_type: 'event' };
}

function eventsNode(event: string, math?: Math): WireEventsNode {
  return math === undefined
    ? { kind: 'EventsNode', event }
    : { kind: 'EventsNode', event, math };
}

// Normalize a result-bearing wire object into the neutral QueryResult. Takes the
// result-bearing object (not the full envelope) so the async path (S4) reuses it on the
// completed `query_status.results` payload unchanged. Branches on the shape of the value:
// when `columns` is present the rows are cell-arrays to zip into keyed objects; when it is
// absent the entries are already result objects and pass through as-is.
export function normalizeResult(
  source: WireResultBearing,
  fromCache: boolean | undefined
): QueryResult {
  const columns: QueryColumn[] = (source.columns ?? []).map((name, i) => {
    const type = source.types?.[i];
    return type === undefined ? { name } : { name, type };
  });

  const rows = columns.length > 0
    ? source.results.map((row) => zipRow(row, columns))
    : source.results
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .map((entry) => entry);

  const result: QueryResult = {
    rows,
    columns,
    generatedAt: new Date().toISOString(),
  };
  if (fromCache !== undefined) {
    result.fromCache = fromCache;
  }
  return result;
}

function zipRow(row: unknown, columns: QueryColumn[]): Record<string, unknown> {
  const keyed: Record<string, unknown> = {};
  if (Array.isArray(row)) {
    columns.forEach((column, i) => {
      keyed[column.name] = row[i];
    });
    return keyed;
  }
  return isRecord(row) ? row : keyed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface HttpQueryAdapterOptions {
  queryEndpoint: string;
  personalKey: string;
  projectId: string;
  fetch: FetchLike;
  // Injectable purely so the poll backoff is drivable without a real wait under test
  // (fake timers / an immediate resolver). Defaults to a real setTimeout-backed delay.
  sleep?: (ms: number) => Promise<void>;
}

// The first real query backend, named by ROLE (never a vendor). It translates each neutral
// primitive into the adapter-internal wire body, POSTs to the config host with Bearer
// personal-key auth, and normalizes the sync envelope into the neutral QueryResult. Every
// wire concern — the `kind` bodies, the field casing, the response envelope — is sealed
// inside this module; the consumer only ever sees `AnalyticsQueryClient` primitives.
export class HttpQueryAdapter<TX extends TaxonomyShape>
  implements AnalyticsQueryClient<TX>
{
  private readonly url: string;
  private readonly personalKey: string;
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: HttpQueryAdapterOptions) {
    const host = options.queryEndpoint.replace(/\/$/, '');
    this.url = `${host}${QUERY_PATH_TEMPLATE(options.projectId)}`;
    this.personalKey = options.personalKey;
    this.fetch = options.fetch;
    this.sleep = options.sleep ?? sleep;
  }

  async funnel(spec: FunnelSpec<TX>): Promise<QueryResult> {
    return this.run({
      kind: 'FunnelsQuery',
      series: spec.steps.map((step) => eventsNode(step)),
      funnelsFilter: {
        funnelWindowInterval: spec.within.value,
        funnelWindowIntervalUnit: spec.within.unit,
      },
      breakdownFilter: eventBreakdown(spec.breakdown),
    });
  }

  async retention(spec: RetentionSpec<TX>): Promise<QueryResult> {
    return this.run({
      kind: 'RetentionQuery',
      retentionFilter: {
        targetEntity: retentionEntity(spec.cohortEvent),
        returningEntity: retentionEntity(spec.returnEvent),
        period: RETENTION_PERIOD_FOR_GRANULARITY[spec.granularity],
        totalIntervals: spec.periods,
      },
      breakdownFilter: eventBreakdown(spec.breakdown),
    });
  }

  async trend(spec: TrendSpec<TX>): Promise<QueryResult> {
    return this.run({
      kind: 'TrendsQuery',
      series: [eventsNode(spec.event, MATH_FOR_AGGREGATION[spec.aggregation])],
      interval: INTERVAL_FOR_UNIT[spec.window.unit],
      dateRange: { date_from: relativeDateFrom(spec.window) },
      breakdownFilter: eventBreakdown(spec.breakdown),
    });
  }

  async uniqueCount(spec: UniqueCountSpec<TX>): Promise<QueryResult> {
    return this.run({
      kind: 'TrendsQuery',
      series: [eventsNode(spec.event, 'dau')],
      interval: INTERVAL_FOR_UNIT[spec.window.unit],
      dateRange: { date_from: relativeDateFrom(spec.window) },
      breakdownFilter: eventBreakdown(spec.breakdown),
    });
  }

  async rawQuery(expr: string): Promise<QueryResult> {
    return this.run({ kind: 'HogQLQuery', query: expr });
  }

  private async run(query: WireQueryNode): Promise<QueryResult> {
    const response = await this.fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ query, refresh: ASYNC_REFRESH }),
    });
    if (response.ok === false) {
      throw new Error('analytics: query request failed');
    }
    const body = (await response.json()) as WirePostResponse;

    // Async when the backend accepted the query off-thread (HTTP 202, or a status
    // envelope not yet complete). The completed status envelope ALSO carries the
    // `query_status` key, so detection keys on `complete === false`, never on presence.
    const status = body.query_status;
    if (response.status === STATUS_ACCEPTED || (status !== undefined && status.complete !== true)) {
      return this.pollToCompletion(status);
    }
    return normalizeResult(body, body.is_cached);
  }

  private async pollToCompletion(initial: WireQueryStatus | undefined): Promise<QueryResult> {
    let status = initial;
    if (status !== undefined && status.complete === true) {
      return this.resultFrom(status);
    }
    if (status === undefined) {
      // 202 with no inline status body: nothing to poll against — a give-up.
      throw new Error('analytics: query did not complete');
    }

    const pollUrl = `${this.url}${status.id}/`;
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
      await this.sleep(pollDelay(attempt));
      const response = await this.fetch(pollUrl, {
        method: 'GET',
        headers: this.headers(),
      });
      if (response.ok === false) {
        throw new Error('analytics: query request failed');
      }
      const body = (await response.json()) as WireAsyncEnvelope;
      status = body.query_status;
      if (status.complete === true) {
        return this.resultFrom(status);
      }
    }
    throw new Error('analytics: query did not complete');
  }

  // Turn a completed status envelope into the neutral result — or surface its failure
  // neutrally. Reuses the SAME normalizer as the sync path on `query_status.results`,
  // which has no sibling columns/types (its columns-absent pass-through branch applies).
  private resultFrom(status: WireQueryStatus): QueryResult {
    if (status.error === true) {
      throw new Error('analytics: query did not complete');
    }
    return normalizeResult(status, status.is_cached);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.personalKey}`,
      'Content-Type': 'application/json',
    };
  }
}

function retentionEntity(event: string): WireRetentionEntity {
  return { id: event, name: event, type: 'events', kind: 'EventsNode' };
}

export function createHttpQueryAdapter<TX extends TaxonomyShape>(
  options: HttpQueryAdapterOptions
): HttpQueryAdapter<TX> {
  return new HttpQueryAdapter<TX>(options);
}

export function createHttpQueryAdapterFromConfig<TX extends TaxonomyShape>(config: {
  queryEndpoint: string;
  personalKey: string;
  projectId?: string;
  fetch?: FetchLike;
}): HttpQueryAdapter<TX> {
  return new HttpQueryAdapter<TX>({
    queryEndpoint: config.queryEndpoint,
    personalKey: config.personalKey,
    projectId: config.projectId ?? '',
    fetch: config.fetch ?? fetch,
  });
}
