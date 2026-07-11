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

// A canned wire response per `kind` in the SYNC envelope shape the adapter's
// `normalizeResult` consumes: `{ results, columns?, types? }` at HTTP 200 with NO
// `query_status` so the inline sync branch is taken (never a real HogQL POST). Rows are
// cell-arrays that get zipped into keyed objects by the parallel `columns`.
const WIRE_BY_KIND: Record<string, { results: unknown[]; columns: string[]; types: string[] }> = {
  FunnelsQuery: {
    columns: ['step', 'count'],
    types: ['String', 'UInt64'],
    results: [
      ['signup_started', 1000],
      ['signup_completed', 620],
      ['document_uploaded', 410],
    ],
  },
  RetentionQuery: {
    columns: ['period', 'retained'],
    types: ['UInt8', 'UInt64'],
    results: [
      [0, 500],
      [1, 310],
      [2, 190],
    ],
  },
  TrendsQuery: {
    columns: ['day', 'value'],
    types: ['Date', 'UInt64'],
    results: [
      ['2026-07-01', 42],
      ['2026-07-02', 55],
    ],
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

function expectWellFormed(result: QueryResult): void {
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
    expect(record.result.columns.map((c) => c.name)).toEqual(['step', 'count']);
    expect(record.result.rows).toEqual([
      { step: 'signup_started', count: 1000 },
      { step: 'signup_completed', count: 620 },
      { step: 'document_uploaded', count: 410 },
    ]);
    expect(record.result.fromCache).toBe(false);
  });

  it('retention (cohort→return) normalizes the mocked response into a well-formed QueryResult', async () => {
    const { fetch, bodies } = createRecordingQueryTransport();
    const record = await reviewerRetentionSnapshot(createFernlyQueryClient(keyedConfig(fetch)));

    expect(record.name).toBe('reviewer_retention');
    expectWellFormed(record.result);
    expect(bodies[0]!.query.kind).toBe('RetentionQuery');
    expect(record.result.rows).toHaveLength(3);
    expect(record.result.rows[0]).toEqual({ period: 0, retained: 500 });
  });

  it('trend (engagement) normalizes the mocked response into a well-formed QueryResult', async () => {
    const { fetch, bodies } = createRecordingQueryTransport();
    const record = await commentEngagementSnapshot(createFernlyQueryClient(keyedConfig(fetch)));

    expect(record.name).toBe('comment_engagement');
    expectWellFormed(record.result);
    expect(bodies[0]!.query.kind).toBe('TrendsQuery');
    expect(record.result.rows).toEqual([
      { day: '2026-07-01', value: 42 },
      { day: '2026-07-02', value: 55 },
    ]);
  });

  it('uniqueCount (active reviewers) normalizes the mocked response into a well-formed QueryResult', async () => {
    const { fetch, bodies } = createRecordingQueryTransport();
    const record = await activeReviewersSnapshot(createFernlyQueryClient(keyedConfig(fetch)));

    expect(record.name).toBe('active_reviewers');
    expectWellFormed(record.result);
    // uniqueCount rides the trends wire node.
    expect(bodies[0]!.query.kind).toBe('TrendsQuery');
    expect(record.result.columns.map((c) => c.name)).toEqual(['day', 'value']);
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
