import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@randomtoni/analytics-kit-node';
import type { QueryResult } from '@randomtoni/analytics-kit';
import {
  activationFunnelSnapshot,
  activeReviewersSnapshot,
  allFernlySnapshots,
  commentEngagementSnapshot,
  createFernlyQueryClient,
  plansMixSnapshot,
  reviewerRetentionSnapshot,
  type FernlyQueryClient,
  type FernlyQueryConfig,
} from './snapshots';

interface WireBody {
  query: { kind: string; query?: string };
  refresh: string;
}

// A canned wire response per `kind` at HTTP 200 with NO `query_status` so the inline sync
// branch is taken (never a real HogQL POST). The STRUCTURED primitives (funnel/retention/
// trend) carry columns-ABSENT insight objects — per-step objects / cohort objects with an
// indexed `values` array / parallel `days`/`data` arrays — which the adapter flattens into
// the neutral per-primitive rows (`{step,event,count,conversionRate}` / `{cohort,periodIndex,
// value}` / `{bucket,value}`). Only the rawQuery/HogQL path is columns-PRESENT cell-arrays
// zipped into keyed objects by the consumer's own SELECT projection.
const WIRE_BY_KIND: Record<string, { results: unknown[]; columns?: string[]; types?: string[] }> = {
  FunnelsQuery: {
    results: [
      { order: 0, name: 'signup_started', count: 1000 },
      { order: 1, name: 'signup_completed', count: 620 },
      { order: 2, name: 'document_uploaded', count: 410 },
    ],
  },
  RetentionQuery: {
    results: [
      { date: '2026-07-01', values: [{ count: 500 }, { count: 310 }, { count: 190 }] },
    ],
  },
  TrendsQuery: {
    results: [{ label: 'comment_added', days: ['2026-07-01', '2026-07-02'], data: [42, 55] }],
  },
  HogQLQuery: {
    columns: ['plan', 'upgrades'],
    types: ['String', 'UInt64'],
    results: [
      ['pro', 128],
      ['enterprise', 37],
    ],
  },
};

function createRecordingQueryTransport(): { fetch: FetchLike; bodies: WireBody[] } {
  const bodies: WireBody[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as WireBody;
    bodies.push(body);
    const wire = WIRE_BY_KIND[body.query.kind];
    if (wire === undefined) {
      return new Response(null, { status: 500 });
    }
    return new Response(JSON.stringify({ ...wire, is_cached: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as FetchLike;
  return { fetch, bodies };
}

// All THREE keys set so `createQueryClient` constructs the real HTTP-backed query adapter
// and the injected `fetch` is consulted — the assertions then prove the neutral→wire→
// QueryResult normalization, not merely the empty-shape no-op contract. Never a real endpoint.
function keyedConfig(fetch: FetchLike): FernlyQueryConfig {
  return {
    queryEndpoint: 'https://query.mock.test',
    personalKey: 'phx_server_read_key',
    projectId: 'proj_fernly',
    fetch,
  };
}

function expectWellFormed(result: QueryResult<unknown>): void {
  expect(Array.isArray(result.rows)).toBe(true);
  expect(Array.isArray(result.columns)).toBe(true);
  expect(typeof result.generatedAt).toBe('string');
  expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);
}

describe('Fernly KPI/snapshot definitions call every query primitive (E8)', () => {
  it('createFernlyQueryClient reaches the real adapter with all three keys and consults the injected fetch', async () => {
    const { fetch, bodies } = createRecordingQueryTransport();
    const client = createFernlyQueryClient(keyedConfig(fetch));

    await activationFunnelSnapshot(client);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://query.mock.test/api/projects/proj_fernly/query/');
    expect(bodies[0]!.query.kind).toBe('FunnelsQuery');
    expect(bodies[0]!.refresh).toBe('async');
  });

  it('funnel (activation) normalizes the mocked response into a well-formed QueryResult', async () => {
    const { fetch } = createRecordingQueryTransport();
    const record = await activationFunnelSnapshot(createFernlyQueryClient(keyedConfig(fetch)));

    expect(record.name).toBe('activation_funnel');
    expectWellFormed(record.result);
    // A structured insight response carries no SELECT projection — columns is empty; the
    // adapter flattens the per-step insight objects into the neutral FunnelStepRow contract.
    expect(record.result.columns).toEqual([]);
    expect(record.result.rows).toEqual([
      { step: 0, event: 'signup_started', count: 1000, conversionRate: 1 },
      { step: 1, event: 'signup_completed', count: 620, conversionRate: 0.62 },
      { step: 2, event: 'document_uploaded', count: 410, conversionRate: 0.41 },
    ]);
    expect(record.result.fromCache).toBe(false);
  });

  it('retention (cohort→return) normalizes the mocked response into a well-formed QueryResult', async () => {
    const { fetch, bodies } = createRecordingQueryTransport();
    const record = await reviewerRetentionSnapshot(createFernlyQueryClient(keyedConfig(fetch)));

    expect(record.name).toBe('reviewer_retention');
    expectWellFormed(record.result);
    expect(bodies[0]!.query.kind).toBe('RetentionQuery');
    // One neutral RetentionRow per (cohort, period) cell; periodIndex 0 = the cohort itself.
    expect(record.result.rows).toEqual([
      { cohort: '2026-07-01', periodIndex: 0, value: 500 },
      { cohort: '2026-07-01', periodIndex: 1, value: 310 },
      { cohort: '2026-07-01', periodIndex: 2, value: 190 },
    ]);
  });

  it('trend (engagement) normalizes the mocked response into a well-formed QueryResult', async () => {
    const { fetch, bodies } = createRecordingQueryTransport();
    const record = await commentEngagementSnapshot(createFernlyQueryClient(keyedConfig(fetch)));

    expect(record.name).toBe('comment_engagement');
    expectWellFormed(record.result);
    expect(bodies[0]!.query.kind).toBe('TrendsQuery');
    // One neutral TrendRow per bucket — flattened from the parallel days[]/data[] arrays.
    expect(record.result.rows).toEqual([
      { bucket: '2026-07-01', value: 42 },
      { bucket: '2026-07-02', value: 55 },
    ]);
  });

  it('uniqueCount (active reviewers) normalizes the mocked response into a well-formed QueryResult', async () => {
    const { fetch, bodies } = createRecordingQueryTransport();
    const record = await activeReviewersSnapshot(createFernlyQueryClient(keyedConfig(fetch)));

    expect(record.name).toBe('active_reviewers');
    expectWellFormed(record.result);
    // uniqueCount rides the trends wire node — same columns-absent insight shape, flattened
    // into neutral TrendRows (no SELECT projection, so columns is empty).
    expect(bodies[0]!.query.kind).toBe('TrendsQuery');
    expect(record.result.columns).toEqual([]);
    expect(record.result.rows).toEqual([
      { bucket: '2026-07-01', value: 42 },
      { bucket: '2026-07-02', value: 55 },
    ]);
  });

  it('rawQuery (escape hatch) normalizes the mocked response into a well-formed QueryResult', async () => {
    const { fetch, bodies } = createRecordingQueryTransport();
    const record = await plansMixSnapshot(createFernlyQueryClient(keyedConfig(fetch)));

    expect(record.name).toBe('plans_mix');
    expectWellFormed(record.result);
    expect(bodies[0]!.query.kind).toBe('HogQLQuery');
    expect(bodies[0]!.query.query).toContain('plan_upgraded');
    expect(record.result.rows).toEqual([
      { plan: 'pro', upgrades: 128 },
      { plan: 'enterprise', upgrades: 37 },
    ]);
  });

  it('allFernlySnapshots wraps every method result in a consumer-side snapshot record', async () => {
    const { fetch } = createRecordingQueryTransport();
    const records = await allFernlySnapshots(createFernlyQueryClient(keyedConfig(fetch)));

    expect(records.map((r) => r.name)).toEqual([
      'activation_funnel',
      'reviewer_retention',
      'comment_engagement',
      'active_reviewers',
      'plans_mix',
    ]);
    for (const record of records) {
      expectWellFormed(record.result);
      expect(typeof record.capturedAt).toBe('string');
    }
  });

  it('bar-B complement: an unkeyed client is a no-op returning a well-formed empty QueryResult, never touching fetch', async () => {
    const fetch = vi.fn() as unknown as FetchLike;
    // No personalKey -> QueryNoop: never constructs an adapter, never POSTs.
    const client = createFernlyQueryClient({ fetch });
    const record = await activationFunnelSnapshot(client);

    expectWellFormed(record.result);
    expect(record.result.rows).toEqual([]);
    expect(record.result.columns).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a wrong event name at compile time (taxonomy-typed)', async () => {
    const { fetch } = createRecordingQueryTransport();
    const client: FernlyQueryClient = createFernlyQueryClient(keyedConfig(fetch));

    await client.trend({
      // @ts-expect-error 'not_a_fernly_event' is not a key of the Fernly taxonomy events.
      event: 'not_a_fernly_event',
      aggregation: 'total',
      window: { value: 7, unit: 'day' },
    });
  });
});
