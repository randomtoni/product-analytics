import type { DefaultTaxonomyShape } from '@randomtoni/analytics-kit';
import { afterEach, expect, test, vi } from 'vitest';
import type { FetchLike } from '../config';
import { createHttpQueryAdapter } from './http-query-adapter';
import {
  ENGINE_ROW_FIELD_NAMES,
  funnelPlain,
  trendSingleSeries,
} from './query-contract.fixtures';

afterEach(() => {
  vi.useRealTimers();
});

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

// A scripted mock fetch: each queued response is consumed in order across successive
// calls, so a POST-returns-pending → GET-poll-flips-complete flow is expressed as a
// script. Each response supplies `ok`/`status`/`json` so the adapter's non-OK guard and
// 202/complete detection are exercised. No real network is ever touched.
interface ScriptedResponse {
  ok?: boolean;
  status?: number;
  json: unknown;
}

function scriptedFetch(responses: ScriptedResponse[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = vi.fn(
    async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
      calls.push({
        url,
        method: init.method,
        headers: init.headers ?? {},
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      });
      const spec = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return {
        ok: spec.ok ?? true,
        status: spec.status ?? 200,
        json: async () => spec.json,
      };
    }
  );
  return { fetchImpl: fetchImpl as unknown as FetchLike, calls };
}

function adapter(responses: ScriptedResponse[]) {
  const { fetchImpl, calls } = scriptedFetch(responses);
  const client = createHttpQueryAdapter<DefaultTaxonomyShape>({
    queryEndpoint: 'https://query.example',
    personalKey: 'pk_read',
    projectId: 'proj-42',
    fetch: fetchImpl,
    // Immediate resolver so the backoff never actually waits under test.
    sleep: async () => {},
  });
  return { client, calls };
}

const PENDING = {
  ok: true,
  status: 202,
  json: { query_status: { id: 'qs-1', complete: false, query_async: true } },
};

// A completed poll carrying a realistic TREND insight payload (structured days[]/data[]
// objects, NO parallel columns — the columns-absent branch). The completed
// `query_status.results` is normalized by the SAME per-primitive builder as the sync path.
const COMPLETE = {
  ok: true,
  status: 200,
  json: {
    query_status: {
      id: 'qs-1',
      complete: true,
      results: trendSingleSeries.wireResults,
    },
  },
};

// A completed poll carrying a realistic FUNNEL insight payload (per-step objects).
const COMPLETE_FUNNEL = {
  ok: true,
  status: 200,
  json: {
    query_status: {
      id: 'qs-1',
      complete: true,
      results: funnelPlain.wireResults,
    },
  },
};

test('async: POST returns pending {query_status:{complete:false}} → polls to completion → normalized QueryResult', async () => {
  const { client, calls } = adapter([PENDING, COMPLETE]);

  const result = await client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 30, unit: 'day' } });

  // The POST carried the async refresh opt-in.
  expect(calls[0].method).toBe('POST');
  expect((calls[0].body as { refresh?: string }).refresh).toBe('async');

  // The poll is a GET to /query/{query_status.id}/ (NOT a re-POST).
  expect(calls[1].method).toBe('GET');
  expect(calls[1].url).toBe('https://query.example/api/projects/proj-42/query/qs-1/');
  expect(calls[1].headers['Authorization']).toBe('Bearer pk_read');

  // The completed trend insight nested at query_status.results is normalized by the SAME
  // per-primitive builder as the sync path — neutral TrendRows, no columns for a primitive.
  expect(result.rows).toEqual(trendSingleSeries.expectedRows);
  expect(result.columns).toEqual([]);
  expect(typeof result.generatedAt).toBe('string');
});

test('async: reads the NESTED query_status.results (object rows, no sibling columns) via the shared normalizer pass-through', async () => {
  const completeObjects = {
    ok: true,
    status: 200,
    json: {
      query_status: {
        id: 'qs-obj',
        complete: true,
        // Insight-object results with no parallel columns — the normalizer's
        // columns-absent pass-through branch applies exactly as on the sync path.
        results: [{ label: 'Mon', count: 3 }, { label: 'Tue', count: 5 }],
      },
    },
  };
  const { client } = adapter([PENDING, completeObjects]);

  const result = await client.rawQuery('SELECT 1');

  expect(result.columns).toEqual([]);
  expect(result.rows).toEqual([{ label: 'Mon', count: 3 }, { label: 'Tue', count: 5 }]);
});

test('async: multiple pending poll responses before completion — loop keeps polling via GET until complete', async () => {
  const { client, calls } = adapter([
    PENDING, // POST
    { json: { query_status: { id: 'qs-1', complete: false } } }, // poll 1
    { json: { query_status: { id: 'qs-1', complete: false } } }, // poll 2
    COMPLETE_FUNNEL, // poll 3
  ]);

  const result = await client.funnel({ steps: ['signed_up', 'order_placed', 'document_uploaded'], within: { value: 7, unit: 'day' } });

  expect(calls).toHaveLength(4);
  expect(calls.slice(1).every((c) => c.method === 'GET')).toBe(true);
  expect(calls.slice(1).every((c) => c.url === 'https://query.example/api/projects/proj-42/query/qs-1/')).toBe(true);
  // The completed funnel insight normalizes to neutral FunnelStepRows — sealed row-level.
  expect(result.rows).toEqual(funnelPlain.expectedRows);
});

test('sync: an inline envelope (no query_status) takes the sync branch unchanged — S3 regression', async () => {
  const syncEnvelope = {
    ok: true,
    status: 200,
    json: {
      results: [['x', 1]],
      columns: ['k', 'v'],
      types: ['String', 'UInt64'],
      is_cached: true,
    },
  };
  const { client, calls } = adapter([syncEnvelope]);

  const result = await client.rawQuery('SELECT 1');

  // A single POST, no poll.
  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe('POST');
  expect(result.rows).toEqual([{ k: 'x', v: 1 }]);
  expect(result.fromCache).toBe(true);
});

test('sync and async return the SAME QueryResult shape — a caller cannot tell them apart', async () => {
  // Same realistic trend insight payload delivered inline (sync) vs nested in the completed
  // status (async) — the caller cannot tell the two paths apart.
  const syncEnvelope = { json: { results: trendSingleSeries.wireResults } };
  const syncClient = adapter([syncEnvelope]);
  const asyncClient = adapter([PENDING, COMPLETE]);

  const fromSync = await syncClient.client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 7, unit: 'day' } });
  const fromAsync = await asyncClient.client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 30, unit: 'day' } });

  expect(Object.keys(fromSync).sort()).toEqual(Object.keys(fromAsync).sort());
  expect(fromSync.rows).toEqual(fromAsync.rows);
  expect(fromSync.rows).toEqual(trendSingleSeries.expectedRows);
  expect(fromSync.columns).toEqual(fromAsync.columns);
});

test('async: a query that NEVER completes terminates (bounded) with a neutral error — no vendor/query_status leak', async () => {
  // Every poll stays pending forever.
  const { client, calls } = adapter([{ json: { query_status: { id: 'qs-stuck', complete: false } } }]);

  await expect(
    client.retention({ cohortEvent: 'a', returnEvent: 'b', periods: 4, granularity: 'day' })
  ).rejects.toThrow('query did not complete');

  // It stopped — it did not hang / poll unboundedly (1 POST + a bounded number of polls).
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.length).toBeLessThanOrEqual(1 + 20);

  // The neutral error carries no vendor identifier or the async envelope key.
  const error = (await client
    .retention({ cohortEvent: 'a', returnEvent: 'b', periods: 4, granularity: 'day' })
    .catch((e: unknown) => e)) as Error;
  expect(error.message).not.toMatch(/query_status/);
  expect(error.message).not.toMatch(/posthog/i);
});

test('async: the poll loop is drivable under FAKE timers with the real setTimeout-backed delay (never hangs)', async () => {
  vi.useFakeTimers();
  const { fetchImpl, calls } = scriptedFetch([PENDING, COMPLETE]);
  // No injected sleep → the real setTimeout-backed backoff, advanced by fake timers.
  const client = createHttpQueryAdapter<DefaultTaxonomyShape>({
    queryEndpoint: 'https://query.example',
    personalKey: 'pk_read',
    projectId: 'proj-42',
    fetch: fetchImpl,
  });

  const promise = client.trend({ event: 'e', aggregation: 'total', window: { value: 30, unit: 'day' } });
  await vi.runAllTimersAsync();
  const result = await promise;

  expect(calls[1].method).toBe('GET');
  expect(result.rows).toEqual(trendSingleSeries.expectedRows);
});

test('async: a query_status.error completion surfaces as a neutral error (no envelope leak)', async () => {
  const failed = {
    json: { query_status: { id: 'qs-err', complete: true, error: true, error_message: 'timeout in clickhouse' } },
  };
  const { client } = adapter([PENDING, failed]);

  const error = (await client
    .rawQuery('SELECT 1')
    .catch((e: unknown) => e)) as Error;

  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe('analytics: query did not complete');
  // The vendor error_message never leaks into the neutral error.
  expect(error.message).not.toMatch(/clickhouse/);
  expect(error.message).not.toMatch(/query_status/);
});

test('async: a 202 with no inline status body gives up neutrally (nothing to poll)', async () => {
  const { client } = adapter([{ ok: true, status: 202, json: {} }]);

  await expect(client.rawQuery('SELECT 1')).rejects.toThrow('query did not complete');
});

test('async: a 200 poll body missing query_status surfaces the neutral error (NOT a raw TypeError)', async () => {
  // POST accepts async; the poll then returns a 200 whose body has NO query_status key —
  // reading `.complete` on the absent status would throw a raw TypeError without the guard.
  const { client } = adapter([PENDING, { ok: true, status: 200, json: {} }]);

  const error = (await client.rawQuery('SELECT 1').catch((e: unknown) => e)) as Error;

  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(TypeError);
  expect(error.message).toBe('analytics: query did not complete');
  expect(error.message).not.toMatch(/query_status/);
});

test('async: a completed status envelope missing results surfaces the neutral error (NOT a raw TypeError)', async () => {
  // The poll flips complete:true but the completed envelope carries NO results array —
  // normalizeResult accessing `.map`/`.filter` on the absent results would raw-TypeError.
  const noResults = {
    ok: true,
    status: 200,
    json: { query_status: { id: 'qs-empty', complete: true } },
  };
  const { client } = adapter([PENDING, noResults]);

  const error = (await client.rawQuery('SELECT 1').catch((e: unknown) => e)) as Error;

  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(TypeError);
  expect(error.message).toBe('analytics: query did not complete');
  expect(error.message).not.toMatch(/results|query_status/);
});

test('a non-OK POST response throws a neutral error (no vendor envelope leaked)', async () => {
  const { client } = adapter([{ ok: false, status: 500, json: { detail: 'internal', type: 'server_error' } }]);

  const error = (await client.rawQuery('SELECT 1').catch((e: unknown) => e)) as Error;
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toBe('analytics: query request failed');
  expect(error.message).not.toMatch(/internal|server_error/);
});

test('a non-OK POLL response throws a neutral error', async () => {
  const { client } = adapter([PENDING, { ok: false, status: 503, json: { detail: 'unavailable' } }]);

  await expect(client.rawQuery('SELECT 1')).rejects.toThrow('analytics: query request failed');
});

test('bar A: the returned value carries ONLY neutral keys — no query_status / results / is_cached leak', async () => {
  // A completed broken-down trend insight — each wire row carries `breakdown_value` and the
  // engine total `aggregated_value`, a row that COULD leak engine field names if unsealed.
  const completeBreakdown = {
    ok: true,
    status: 200,
    json: {
      query_status: {
        id: 'qs-bd',
        complete: true,
        results: [
          { label: 'e - pro', breakdown_value: 'pro', days: ['2026-07-01'], data: [8], aggregated_value: 8 },
          { label: 'e - free', breakdown_value: 'free', days: ['2026-07-01'], data: [4], aggregated_value: 4 },
        ],
      },
    },
  };
  const { client } = adapter([PENDING, completeBreakdown]);
  const result = await client.trend({ event: 'e', aggregation: 'total', window: { value: 30, unit: 'day' }, breakdown: 'plan' });

  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain('query_status');
  expect(serialized).not.toContain('is_cached');
  expect(serialized).not.toContain('"results"');
  expect(serialized).not.toMatch(/posthog/i);
  // Row-level seal: no engine-internal ROW field name survives into the serialized rows.
  const rowsSerialized = JSON.stringify(result.rows);
  for (const field of ENGINE_ROW_FIELD_NAMES) {
    expect(rowsSerialized).not.toContain(field);
  }
  expect(rowsSerialized).not.toContain('aggregated_value');
  // The neutral breakdown DID surface — under `breakdown`, not `breakdown_value`.
  expect(result.rows[0]).toEqual({ bucket: '2026-07-01', value: 8, breakdown: 'pro' });
  expect(Object.keys(result).sort()).toEqual(['columns', 'generatedAt', 'rows']);
});
