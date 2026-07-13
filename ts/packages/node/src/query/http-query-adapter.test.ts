import type { DefaultTaxonomyShape } from '@randomtoni/analytics-kit';
import { expect, test, vi } from 'vitest';
import type { FetchLike } from '../config';
import type { AnalyticsQueryClient } from './query-client';
import {
  createHttpQueryAdapter,
  createHttpQueryAdapterFromConfig,
  HttpQueryAdapter,
  normalizeResult,
} from './http-query-adapter';
import {
  ENGINE_ROW_FIELD_NAMES,
  funnelBreakdown,
  funnelEventPrecedence,
  funnelPlain,
  funnelZeroFirstStep,
  retentionCohorts,
  trendBreakdown,
  trendSingleSeries,
  uniqueCountSingleSeries,
} from './query-contract.fixtures';

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

// A mock fetch matching the E7 injected-fetch spy precedent. It records each call and
// returns a canned sync envelope (via `.json()`) so no real network is ever touched.
function mockFetch(envelope: unknown) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers ?? {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    });
    return {
      status: 200,
      json: async () => envelope,
    };
  });
  return { fetchImpl: fetchImpl as unknown as FetchLike, calls };
}

function adapter(envelope: unknown, options?: { queryEndpoint?: string; projectId?: string; personalKey?: string }) {
  const { fetchImpl, calls } = mockFetch(envelope);
  const client = createHttpQueryAdapter<DefaultTaxonomyShape>({
    queryEndpoint: options?.queryEndpoint ?? 'https://query.example',
    personalKey: options?.personalKey ?? 'pk_read',
    projectId: options?.projectId ?? 'proj-42',
    fetch: fetchImpl,
  });
  return { client, calls };
}

const SYNC_ENVELOPE = {
  results: [
    ['2026-07-01', 12],
    ['2026-07-02', 30],
  ],
  columns: ['day', 'count'],
  types: ['DateTime', 'UInt64'],
  hogql: 'SELECT ...',
  is_cached: true,
};

test('POSTs to {queryEndpoint}/api/projects/{projectId}/query/ with Bearer auth + json content-type', async () => {
  const { client, calls } = adapter(SYNC_ENVELOPE);

  await client.rawQuery('SELECT 1');

  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://query.example/api/projects/proj-42/query/');
  expect(calls[0].method).toBe('POST');
  expect(calls[0].headers['Authorization']).toBe('Bearer pk_read');
  expect(calls[0].headers['Content-Type']).toBe('application/json');
});

test('projectId is a PATH segment resolved from the config host', async () => {
  const { client, calls } = adapter(SYNC_ENVELOPE, {
    queryEndpoint: 'https://eu.query.example',
    projectId: '99',
  });
  await client.rawQuery('SELECT 1');
  expect(calls[0].url).toBe('https://eu.query.example/api/projects/99/query/');
});

test('a trailing slash on the queryEndpoint host is not doubled in the URL', async () => {
  const { client, calls } = adapter(SYNC_ENVELOPE, { queryEndpoint: 'https://query.example/' });
  await client.rawQuery('SELECT 1');
  expect(calls[0].url).toBe('https://query.example/api/projects/proj-42/query/');
});

test('never synthesizes a vendor host — the URL is exactly {config host}{path}, no .com default', async () => {
  const { client, calls } = adapter(SYNC_ENVELOPE, { queryEndpoint: 'https://self-hosted.internal' });
  await client.rawQuery('SELECT 1');
  expect(calls[0].url).not.toMatch(/posthog/i);
  expect(calls[0].url.startsWith('https://self-hosted.internal/')).toBe(true);
});

test('trend → { query: { kind: TrendsQuery, ... } } sent DIRECTLY (not wrapped in InsightVizNode)', async () => {
  const { client, calls } = adapter(SYNC_ENVELOPE);

  await client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 30, unit: 'day' } });

  const body = calls[0].body as { query: Record<string, unknown> };
  expect(body.query.kind).toBe('TrendsQuery');
  expect((body as Record<string, unknown>).source).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain('InsightVizNode');
  expect(body.query.series).toEqual([{ kind: 'EventsNode', event: 'order_placed', math: 'total' }]);
  expect(body.query.interval).toBe('day');
  expect(body.query.dateRange).toEqual({ date_from: '-30d' });
});

test('trend aggregation maps to the wire math enum (unique/dau → dau)', async () => {
  const { client, calls } = adapter(SYNC_ENVELOPE);

  await client.trend({ event: 'order_placed', aggregation: 'unique', window: { value: 7, unit: 'week' } });
  const body = calls[0].body as { query: { series: Array<{ math: string }>; interval: string; dateRange: { date_from: string } } };
  expect(body.query.series[0].math).toBe('dau');
  expect(body.query.interval).toBe('week');
  expect(body.query.dateRange.date_from).toBe('-7w');
});

test('uniqueCount → TrendsQuery with dau math over the window', async () => {
  const { client, calls } = adapter(SYNC_ENVELOPE);

  await client.uniqueCount({ event: 'order_placed', window: { value: 1, unit: 'month' } });
  const body = calls[0].body as { query: { kind: string; series: Array<{ event: string; math: string }>; interval: string; dateRange: { date_from: string } } };
  expect(body.query.kind).toBe('TrendsQuery');
  expect(body.query.series[0]).toEqual({ kind: 'EventsNode', event: 'order_placed', math: 'dau' });
  expect(body.query.interval).toBe('month');
  expect(body.query.dateRange.date_from).toBe('-1M');
});

test('funnel → { query: { kind: FunnelsQuery, ... } } with ordered steps + window filter', async () => {
  const { client, calls } = adapter(SYNC_ENVELOPE);

  await client.funnel({ steps: ['signed_up', 'order_placed'], within: { value: 14, unit: 'day' } });

  const body = calls[0].body as { query: { kind: string; series: Array<{ kind: string; event: string }>; funnelsFilter: Record<string, unknown> } };
  expect(body.query.kind).toBe('FunnelsQuery');
  expect(body.query.series).toEqual([
    { kind: 'EventsNode', event: 'signed_up' },
    { kind: 'EventsNode', event: 'order_placed' },
  ]);
  expect(body.query.funnelsFilter).toEqual({ funnelWindowInterval: 14, funnelWindowIntervalUnit: 'day' });
});

test('retention → { query: { kind: RetentionQuery, ... } } with target/returning entities + period', async () => {
  const { client, calls } = adapter(SYNC_ENVELOPE);

  await client.retention({ cohortEvent: 'signed_up', returnEvent: 'order_placed', periods: 8, granularity: 'week' });

  const body = calls[0].body as { query: { kind: string; retentionFilter: Record<string, unknown> } };
  expect(body.query.kind).toBe('RetentionQuery');
  expect(body.query.retentionFilter).toEqual({
    targetEntity: { id: 'signed_up', name: 'signed_up', type: 'events', kind: 'EventsNode' },
    returningEntity: { id: 'order_placed', name: 'order_placed', type: 'events', kind: 'EventsNode' },
    period: 'Week',
    totalIntervals: 8,
  });
});

test('retention granularity maps to the CAPITALIZED wire period (day → Day, month → Month)', async () => {
  const { client, calls } = adapter(SYNC_ENVELOPE);
  await client.retention({ cohortEvent: 'signed_up', returnEvent: 'order_placed', periods: 4, granularity: 'day' });
  const body = calls[0].body as { query: { retentionFilter: { period: string } } };
  expect(body.query.retentionFilter.period).toBe('Day');
});

test('rawQuery(expr) → { query: { kind: HogQLQuery, query: expr } } through the same POST path', async () => {
  const { client, calls } = adapter(SYNC_ENVELOPE);

  await client.rawQuery('SELECT count() FROM events');

  expect(calls[0].url).toBe('https://query.example/api/projects/proj-42/query/');
  expect(calls[0].headers['Authorization']).toBe('Bearer pk_read');
  const body = calls[0].body as { query: { kind: string; query: string } };
  expect(body.query).toEqual({ kind: 'HogQLQuery', query: 'SELECT count() FROM events' });
});

test('breakdown, when supplied, becomes an event breakdownFilter; omitted otherwise', async () => {
  const withBreakdown = adapter(SYNC_ENVELOPE);
  await withBreakdown.client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 7, unit: 'day' }, breakdown: 'plan' });
  const b1 = withBreakdown.calls[0].body as { query: { breakdownFilter?: unknown } };
  expect(b1.query.breakdownFilter).toEqual({ breakdown: 'plan', breakdown_type: 'event' });

  const withoutBreakdown = adapter(SYNC_ENVELOPE);
  await withoutBreakdown.client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 7, unit: 'day' } });
  const b2 = withoutBreakdown.calls[0].body as { query: Record<string, unknown> };
  expect('breakdownFilter' in b2.query && b2.query.breakdownFilter !== undefined).toBe(false);
});

test('sync trend insight envelope normalizes to neutral TrendRows: bucket/value rows, no columns, fromCache from is_cached', async () => {
  // A real trend insight response carries structured `results` objects (days[]/data[]) and
  // NO parallel columns — the columns-absent branch. The adapter flattens it to TrendRows.
  const { client } = adapter({ results: trendSingleSeries.wireResults, is_cached: true });

  const result = await client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 7, unit: 'day' } });

  expect(result.rows).toEqual(trendSingleSeries.expectedRows);
  // Structured insight results carry no SELECT projection — columns is empty for a primitive.
  expect(result.columns).toEqual([]);
  expect(result.fromCache).toBe(true);
  expect(typeof result.generatedAt).toBe('string');
  expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);
});

test('columns are ordered to match the wire column order', async () => {
  const { client } = adapter({
    results: [[1, 'a', true]],
    columns: ['n', 's', 'b'],
    types: ['UInt64', 'String', 'Bool'],
  });
  const result = await client.rawQuery('SELECT 1');
  expect(result.columns.map((c) => c.name)).toEqual(['n', 's', 'b']);
  expect(result.rows[0]).toEqual({ n: 1, s: 'a', b: true });
});

test('is_cached ABSENT (uncached base response) → fromCache is left UNSET (not coerced to false)', async () => {
  const { client } = adapter({
    results: [['x', 1]],
    columns: ['k', 'v'],
    types: ['String', 'UInt64'],
    // no is_cached — the uncached base HogQLQueryResponse omits it
  });

  const result = await client.rawQuery('SELECT 1');

  expect(result.fromCache).toBeUndefined();
  expect('fromCache' in result).toBe(false);
  expect(result.rows).toEqual([{ k: 'x', v: 1 }]);
});

test('is_cached: false present → fromCache is false', async () => {
  const { client } = adapter({ results: [], columns: ['c'], types: ['String'], is_cached: false });
  const result = await client.rawQuery('SELECT 1');
  expect(result.fromCache).toBe(false);
});

test('the raw vendor envelope shape (results/columns/types/hogql/is_cached/kind) appears NOWHERE in the returned value', async () => {
  // Feed a broken-down insight fixture so each wire entry carries `breakdown_value` (and the
  // trend total `aggregated_value`) — a row that COULD leak engine field names if unsealed.
  const { client } = adapter({
    results: [
      { label: 'order_placed - pro', breakdown_value: 'pro', days: ['2026-07-01'], data: [8], aggregated_value: 8 },
      { label: 'order_placed - free', breakdown_value: 'free', days: ['2026-07-01'], data: [4], aggregated_value: 4 },
    ],
    is_cached: true,
  });
  const result = await client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 7, unit: 'day' }, breakdown: 'plan' });

  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain('is_cached');
  expect(serialized).not.toContain('hogql');
  expect(serialized).not.toContain('"results"');
  expect(serialized).not.toContain('kind');
  // Row-level seal: no engine-internal ROW field name survives into the serialized rows.
  const rowsSerialized = JSON.stringify(result.rows);
  for (const field of ENGINE_ROW_FIELD_NAMES) {
    expect(rowsSerialized).not.toContain(field);
  }
  expect(rowsSerialized).not.toContain('aggregated_value');
  // The neutral breakdown value DID surface — under the neutral `breakdown` key, not `breakdown_value`.
  expect(result.rows[0]).toEqual({ bucket: '2026-07-01', value: 8, breakdown: 'pro' });
  // The neutral value carries `rows`/`columns`/`generatedAt`/`fromCache` only.
  expect(Object.keys(result).sort()).toEqual(['columns', 'fromCache', 'generatedAt', 'rows']);
});

test('normalizeResult zips cell-array rows when columns are present', () => {
  const result = normalizeResult(
    { results: [[1, 2]], columns: ['a', 'b'], types: ['UInt64', 'UInt64'] },
    true
  );
  expect(result.rows).toEqual([{ a: 1, b: 2 }]);
  expect(result.fromCache).toBe(true);
});

test('a columns-ABSENT insight object is NORMALIZED into the neutral row type by the primitive (NOT passed through)', async () => {
  // Trends/funnels/retention responses carry result OBJECTS with no parallel columns. The
  // engine-internal shape must NOT pass through — the primitive flattens it into neutral
  // rows. (Pre-E15 this test pinned pass-through as correct; that was the leak this epic closed.)
  const { client } = adapter({ results: trendSingleSeries.wireResults });

  const result = await client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 7, unit: 'day' } });

  expect(result.columns).toEqual([]);
  // Normalized to TrendRows — the raw insight keys (`label`, `days`, `data`, `count`) are gone.
  expect(result.rows).toEqual(trendSingleSeries.expectedRows);
  const serialized = JSON.stringify(result.rows);
  for (const rawKey of ['label', '"days"', '"data"', '"count"']) {
    expect(serialized).not.toContain(rawKey);
  }
  expect('fromCache' in result).toBe(false);
});

test('normalizeResult defends a non-array row under present columns (falls back, no crash)', () => {
  const result = normalizeResult(
    { results: [{ already: 'object' }], columns: ['a'], types: ['String'] },
    false
  );
  expect(result.rows).toEqual([{ already: 'object' }]);
});

test('normalizeResult drops non-object entries in the columns-absent branch', () => {
  const result = normalizeResult({ results: [42, null, { ok: 1 }] }, undefined);
  expect(result.rows).toEqual([{ ok: 1 }]);
});

test('normalizeResult throws the neutral error (NOT a raw TypeError) when results is absent', () => {
  // The wire envelope is untrusted: a completed/zero-row body missing `results` must not
  // raw-TypeError off `.map`/`.filter` — it surfaces as the neutral did-not-complete error.
  let thrown: unknown;
  try {
    normalizeResult({} as unknown as Parameters<typeof normalizeResult>[0], undefined);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(TypeError);
  expect((thrown as Error).message).toBe('analytics: query did not complete');
});

test('createHttpQueryAdapterFromConfig builds a working adapter from queryEndpoint/personalKey/projectId/fetch', async () => {
  const { fetchImpl, calls } = mockFetch(SYNC_ENVELOPE);
  const client = createHttpQueryAdapterFromConfig<DefaultTaxonomyShape>({
    queryEndpoint: 'https://query.example',
    personalKey: 'pk_read',
    projectId: 'proj-42',
    fetch: fetchImpl,
  });

  await client.rawQuery('SELECT 1');

  expect(calls[0].url).toBe('https://query.example/api/projects/proj-42/query/');
  expect(calls[0].headers['Authorization']).toBe('Bearer pk_read');
});

test('createHttpQueryAdapterFromConfig defaults an absent projectId to the empty path segment', async () => {
  const { fetchImpl, calls } = mockFetch(SYNC_ENVELOPE);
  const client = createHttpQueryAdapterFromConfig<DefaultTaxonomyShape>({
    queryEndpoint: 'https://query.example',
    personalKey: 'pk_read',
    fetch: fetchImpl,
  });

  await client.rawQuery('SELECT 1');

  expect(calls[0].url).toBe('https://query.example/api/projects//query/');
});

// ── Per-primitive wire→neutral-row CONTRACT fixtures ─────────────────────────
// The authoritative documented contract (S4 points the README/parity artifact here): a
// realistic wire insight response per structured primitive, asserted against its exact
// neutral rows. Each drives the fixture through the primitive method, proving the adapter's
// normalizer produces the neutral contract — not the engine-internal insight shape.

test('CONTRACT trend, single series → one neutral TrendRow per (bucket, value)', async () => {
  const { client } = adapter({ results: trendSingleSeries.wireResults });
  const result = await client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 7, unit: 'day' } });
  expect(result.rows).toEqual(trendSingleSeries.expectedRows);
});

test('CONTRACT trend, breakdown → one row-series per breakdown_value, neutral breakdown on each row', async () => {
  const { client } = adapter({ results: trendBreakdown.wireResults });
  const result = await client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 7, unit: 'day' }, breakdown: 'plan' });
  expect(result.rows).toEqual(trendBreakdown.expectedRows);
});

test('CONTRACT uniqueCount → same neutral TrendRow shape as trend (shared wire shape)', async () => {
  const { client } = adapter({ results: uniqueCountSingleSeries.wireResults });
  const result = await client.uniqueCount({ event: 'active_reviewers', window: { value: 7, unit: 'day' } });
  expect(result.rows).toEqual(uniqueCountSingleSeries.expectedRows);
});

test('CONTRACT funnel, plain → step rows with COMPUTED conversionRate (count/count[0])', async () => {
  const { client } = adapter({ results: funnelPlain.wireResults });
  const result = await client.funnel({ steps: ['signed_up', 'order_placed', 'document_uploaded'], within: { value: 7, unit: 'day' } });
  expect(result.rows).toEqual(funnelPlain.expectedRows);
});

test('CONTRACT funnel, count[0] === 0 → conversionRate 0 on every step (guarded division)', async () => {
  const { client } = adapter({ results: funnelZeroFirstStep.wireResults });
  const result = await client.funnel({ steps: ['signed_up', 'order_placed'], within: { value: 7, unit: 'day' } });
  expect(result.rows).toEqual(funnelZeroFirstStep.expectedRows);
});

test('CONTRACT funnel, event precedence custom_name → name → action_id (first present non-empty)', async () => {
  const { client } = adapter({ results: funnelEventPrecedence.wireResults });
  const result = await client.funnel({ steps: ['signed_up', 'order_placed', 'checkout'], within: { value: 7, unit: 'day' } });
  expect(result.rows).toEqual(funnelEventPrecedence.expectedRows);
});

test('CONTRACT funnel, array-of-arrays breakdown → per-GROUP conversionRate + breakdown on each row', async () => {
  const { client } = adapter({ results: funnelBreakdown.wireResults });
  const result = await client.funnel({ steps: ['signed_up', 'order_placed'], within: { value: 7, unit: 'day' }, breakdown: 'plan' });
  expect(result.rows).toEqual(funnelBreakdown.expectedRows);
});

test('CONTRACT retention → one row per (cohort, periodIndex); periodIndex 0 = the cohort itself', async () => {
  const { client } = adapter({ results: retentionCohorts.wireResults });
  const result = await client.retention({ cohortEvent: 'signed_up', returnEvent: 'order_placed', periods: 3, granularity: 'week' });
  expect(result.rows).toEqual(retentionCohorts.expectedRows);
});

test('bar A: HttpQueryAdapter is assignable to AnalyticsQueryClient<TX> (a second backend swaps in with zero consumer change)', () => {
  const { fetchImpl } = mockFetch(SYNC_ENVELOPE);
  const client = new HttpQueryAdapter<DefaultTaxonomyShape>({
    queryEndpoint: 'https://query.example',
    personalKey: 'pk',
    projectId: 'p',
    fetch: fetchImpl,
  });
  // Assigning to the neutral interface type is the structural proof.
  const asInterface: AnalyticsQueryClient<DefaultTaxonomyShape> = client;
  expect(typeof asInterface.funnel).toBe('function');
  expect(typeof asInterface.rawQuery).toBe('function');
});
