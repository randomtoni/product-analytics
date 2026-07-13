import type {
  FunnelStepRow,
  QueryColumn,
  QueryResult,
  RetentionRow,
  TaxonomyShape,
  TrendRow,
  UniqueCountRow,
} from '@randomtoni/analytics-kit';
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

// Everything below models the backend's HTTP query wire and NEVER leaves this module:
// the `kind` discriminators, the field casing quirks, the `math` enum, and the response
// envelope are all confined here. The exported surface (`AnalyticsQueryClient`, the spec
// types, `QueryResult`) carries business primitives only — no wire vocabulary escapes.

// The query-node `kind` discriminators. Each is a wire value the PostHog-compatible query
// endpoint requires verbatim (like `$pageview` on the capture wire), hoisted into one
// confined const per the established `_WIRE_` discipline — single-source, non-exported.
const EVENTS_NODE_WIRE_KIND = 'EventsNode' as const;
const TRENDS_QUERY_WIRE_KIND = 'TrendsQuery' as const;
const FUNNELS_QUERY_WIRE_KIND = 'FunnelsQuery' as const;
const RETENTION_QUERY_WIRE_KIND = 'RetentionQuery' as const;
const HOGQL_QUERY_WIRE_KIND = 'HogQLQuery' as const;

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
  kind: typeof EVENTS_NODE_WIRE_KIND;
  event: string;
  math?: Math;
}

interface WireTrendsQuery {
  kind: typeof TRENDS_QUERY_WIRE_KIND;
  series: WireEventsNode[];
  interval: Interval;
  dateRange: WireDateRange;
  breakdownFilter?: WireBreakdownFilter;
}

interface WireFunnelsQuery {
  kind: typeof FUNNELS_QUERY_WIRE_KIND;
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
  kind: typeof EVENTS_NODE_WIRE_KIND;
}

interface WireRetentionQuery {
  kind: typeof RETENTION_QUERY_WIRE_KIND;
  retentionFilter: {
    targetEntity: WireRetentionEntity;
    returningEntity: WireRetentionEntity;
    period: RetentionPeriod;
    totalIntervals: number;
  };
  breakdownFilter?: WireBreakdownFilter;
}

interface WireHogQLQuery {
  kind: typeof HOGQL_QUERY_WIRE_KIND;
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
    ? { kind: EVENTS_NODE_WIRE_KIND, event }
    : { kind: EVENTS_NODE_WIRE_KIND, event, math };
}

// A per-primitive row builder: maps the untrusted result-bearing wire object into the
// primitive's neutral row array. The SHARED envelope handling (results-present guard,
// columns/generatedAt/fromCache assembly, the neutral did-not-complete error) is factored
// into `normalizeResult`; only the row-building step is per-primitive, threaded down
// through `run`/`pollToCompletion`/`resultFrom` so sync and async yield identical rows.
type RowBuilder<TRow> = (source: WireResultBearing) => ReadonlyArray<TRow>;

// Normalize a result-bearing wire object into the neutral QueryResult, delegating the
// row-shaping to a per-primitive `rowBuilder`. Takes the result-bearing object (not the
// full envelope) so the async path reuses it on the completed `query_status.results`
// payload unchanged. The envelope scaffolding (the untrusted-JSON guard, columns/
// generatedAt/fromCache) stays here in ONE place across every primitive. The builder
// defaults to `rawQuery`'s verbatim pass-through — the pre-per-primitive behavior.
export function normalizeResult<TRow = Record<string, unknown>>(
  source: WireResultBearing,
  fromCache: boolean | undefined,
  rowBuilder: RowBuilder<TRow> = buildRawRows as RowBuilder<TRow>
): QueryResult<TRow> {
  // `results` is required on the well-formed envelope, but the JSON is untrusted: a
  // completed/zero-row envelope missing it must surface neutrally, never as a raw TypeError.
  if (!Array.isArray(source.results)) {
    throw new Error('analytics: query did not complete');
  }

  const columns: QueryColumn[] = (source.columns ?? []).map((name, i) => {
    const type = source.types?.[i];
    return type === undefined ? { name } : { name, type };
  });

  const result: QueryResult<TRow> = {
    rows: rowBuilder(source),
    columns,
    generatedAt: new Date().toISOString(),
  };
  if (fromCache !== undefined) {
    result.fromCache = fromCache;
  }
  return result;
}

// `rawQuery`'s builder: the ONE primitive that is NOT per-primitive-flattened. Reproduces
// today's shared logic exactly — when `columns` is present the rows are cell-arrays zipped
// into column-keyed objects (the consumer's own SELECT projection, already neutral); when
// absent, result objects pass through with the record filter. This is the sole surface a
// dialect-keyed shape legitimately reaches, and it is verbatim column-keyed pass-through.
function buildRawRows(source: WireResultBearing): ReadonlyArray<Record<string, unknown>> {
  const results = source.results;
  const columns = source.columns ?? [];
  if (columns.length > 0) {
    return results.map((row) => zipRow(row, columns));
  }
  return results.filter((entry): entry is Record<string, unknown> => isRecord(entry));
}

// De-branded from posthog's trends result: each `results` entry carries positionally-
// parallel `days: string[]` (ISO bucket dates) and `data: number[]` (one value per
// bucket), flattened to one neutral row per index. `uniqueCount` is byte-identical on the
// wire (same shape, only server-side math differs) so it shares this builder. With a
// breakdown the backend returns one top-level entry per breakdown value, each with its own
// days/data + `breakdown_value`; each entry's rows carry that stringified breakdown.
function buildTrendRows(source: WireResultBearing): ReadonlyArray<TrendRow> {
  const rows: TrendRow[] = [];
  for (const entry of source.results) {
    if (!isRecord(entry)) {
      continue;
    }
    const days = entry.days;
    const data = entry.data;
    if (!Array.isArray(days) || !Array.isArray(data)) {
      continue;
    }
    const breakdown = optionalBreakdown(entry.breakdown_value);
    for (let i = 0; i < days.length; i += 1) {
      const bucket = days[i];
      const value = data[i];
      if (typeof bucket !== 'string' || typeof value !== 'number') {
        continue;
      }
      rows.push(breakdown === undefined ? { bucket, value } : { bucket, value, breakdown });
    }
  }
  return rows;
}

// De-branded from posthog's funnel result: `results` is per-step objects (an array-of-
// arrays when broken down — the outer layer is unwrapped per breakdown group). Each step
// carries `order` (0-based index), `count`, and `custom_name`/`name`/`action_id` for the
// event identity. `conversionRate` is NOT a wire field — it is COMPUTED as
// `count[step] / count[0]` (overall conversion from the first step, guarded for count[0] 0).
function buildFunnelRows(source: WireResultBearing): ReadonlyArray<FunnelStepRow> {
  const rows: FunnelStepRow[] = [];
  for (const group of source.results) {
    // Broken-down funnels nest one step array per breakdown group; a plain funnel is a
    // flat step array. Normalize both to "a step array with an optional group breakdown".
    if (Array.isArray(group)) {
      rows.push(...funnelGroupRows(group));
    } else {
      rows.push(...funnelGroupRows(source.results));
      break;
    }
  }
  return rows;
}

function funnelGroupRows(steps: unknown[]): FunnelStepRow[] {
  const firstCount = firstStepCount(steps);
  const out: FunnelStepRow[] = [];
  for (const step of steps) {
    if (!isRecord(step)) {
      continue;
    }
    const order = step.order;
    const count = step.count;
    if (typeof order !== 'number' || typeof count !== 'number') {
      continue;
    }
    const event = funnelEvent(step);
    if (event === undefined) {
      continue;
    }
    const conversionRate = firstCount === 0 ? 0 : count / firstCount;
    const breakdown = optionalBreakdown(step.breakdown_value);
    out.push(
      breakdown === undefined
        ? { step: order, event, count, conversionRate }
        : { step: order, event, count, conversionRate, breakdown }
    );
  }
  return out;
}

function firstStepCount(steps: unknown[]): number {
  for (const step of steps) {
    if (isRecord(step) && step.order === 0 && typeof step.count === 'number') {
      return step.count;
    }
  }
  const first = steps[0];
  return isRecord(first) && typeof first.count === 'number' ? first.count : 0;
}

function funnelEvent(step: Record<string, unknown>): string | undefined {
  for (const key of ['custom_name', 'name', 'action_id'] as const) {
    const value = step[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

// De-branded from posthog's retention result: `results` is cohort objects, each with
// `date` (the cohort start, ISO) and `values: { count }[]` where the array index is the
// period (0 = the cohort itself). Double loop: one neutral row per (cohort, period) cell.
function buildRetentionRows(source: WireResultBearing): ReadonlyArray<RetentionRow> {
  const rows: RetentionRow[] = [];
  for (const cohort of source.results) {
    if (!isRecord(cohort)) {
      continue;
    }
    const date = cohort.date;
    const values = cohort.values;
    if (typeof date !== 'string' || !Array.isArray(values)) {
      continue;
    }
    const breakdown = optionalBreakdown(cohort.breakdown_value);
    for (let j = 0; j < values.length; j += 1) {
      const cell = values[j];
      if (!isRecord(cell) || typeof cell.count !== 'number') {
        continue;
      }
      rows.push(
        breakdown === undefined
          ? { cohort: date, periodIndex: j, value: cell.count }
          : { cohort: date, periodIndex: j, value: cell.count, breakdown }
      );
    }
  }
  return rows;
}

// The wire `breakdown_value` is engine-internal and untyped; surface it as the neutral
// `breakdown` field only when present, stringified, and never as a raw key on the row.
function optionalBreakdown(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function zipRow(row: unknown, columns: string[]): Record<string, unknown> {
  const keyed: Record<string, unknown> = {};
  if (Array.isArray(row)) {
    columns.forEach((name, i) => {
      keyed[name] = row[i];
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

  async funnel(spec: FunnelSpec<TX>): Promise<QueryResult<FunnelStepRow>> {
    return this.run(
      {
        kind: FUNNELS_QUERY_WIRE_KIND,
        series: spec.steps.map((step) => eventsNode(step)),
        funnelsFilter: {
          funnelWindowInterval: spec.within.value,
          funnelWindowIntervalUnit: spec.within.unit,
        },
        breakdownFilter: eventBreakdown(spec.breakdown),
      },
      buildFunnelRows
    );
  }

  async retention(spec: RetentionSpec<TX>): Promise<QueryResult<RetentionRow>> {
    return this.run(
      {
        kind: RETENTION_QUERY_WIRE_KIND,
        retentionFilter: {
          targetEntity: retentionEntity(spec.cohortEvent),
          returningEntity: retentionEntity(spec.returnEvent),
          period: RETENTION_PERIOD_FOR_GRANULARITY[spec.granularity],
          totalIntervals: spec.periods,
        },
        breakdownFilter: eventBreakdown(spec.breakdown),
      },
      buildRetentionRows
    );
  }

  async trend(spec: TrendSpec<TX>): Promise<QueryResult<TrendRow>> {
    return this.run(
      {
        kind: TRENDS_QUERY_WIRE_KIND,
        series: [eventsNode(spec.event, MATH_FOR_AGGREGATION[spec.aggregation])],
        interval: INTERVAL_FOR_UNIT[spec.window.unit],
        dateRange: { date_from: relativeDateFrom(spec.window) },
        breakdownFilter: eventBreakdown(spec.breakdown),
      },
      buildTrendRows
    );
  }

  async uniqueCount(spec: UniqueCountSpec<TX>): Promise<QueryResult<UniqueCountRow>> {
    // uniqueCount is byte-identical to trend on the wire — same `days`/`data` shape, only
    // the server-side math differs — so it reuses the SAME row builder, no branching.
    return this.run(
      {
        kind: TRENDS_QUERY_WIRE_KIND,
        series: [eventsNode(spec.event, 'dau')],
        interval: INTERVAL_FOR_UNIT[spec.window.unit],
        dateRange: { date_from: relativeDateFrom(spec.window) },
        breakdownFilter: eventBreakdown(spec.breakdown),
      },
      buildTrendRows
    );
  }

  async rawQuery(expr: string): Promise<QueryResult> {
    return this.run({ kind: HOGQL_QUERY_WIRE_KIND, query: expr }, buildRawRows);
  }

  private async run<TRow>(
    query: WireQueryNode,
    rowBuilder: RowBuilder<TRow>
  ): Promise<QueryResult<TRow>> {
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
      return this.pollToCompletion(status, rowBuilder);
    }
    return normalizeResult(body, body.is_cached, rowBuilder);
  }

  private async pollToCompletion<TRow>(
    initial: WireQueryStatus | undefined,
    rowBuilder: RowBuilder<TRow>
  ): Promise<QueryResult<TRow>> {
    let status = initial;
    if (status !== undefined && status.complete === true) {
      return this.resultFrom(status, rowBuilder);
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
      const body = (await response.json()) as Partial<WireAsyncEnvelope>;
      status = body.query_status;
      if (status === undefined) {
        throw new Error('analytics: query did not complete');
      }
      if (status.complete === true) {
        return this.resultFrom(status, rowBuilder);
      }
    }
    throw new Error('analytics: query did not complete');
  }

  // Turn a completed status envelope into the neutral result — or surface its failure
  // neutrally. Applies the SAME per-primitive row builder as the sync path to the
  // completed `query_status.results` payload, so sync and async yield identical rows.
  private resultFrom<TRow>(
    status: WireQueryStatus,
    rowBuilder: RowBuilder<TRow>
  ): QueryResult<TRow> {
    if (status.error === true) {
      throw new Error('analytics: query did not complete');
    }
    return normalizeResult(status, status.is_cached, rowBuilder);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.personalKey}`,
      'Content-Type': 'application/json',
    };
  }
}

function retentionEntity(event: string): WireRetentionEntity {
  return { id: event, name: event, type: 'events', kind: EVENTS_NODE_WIRE_KIND };
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
