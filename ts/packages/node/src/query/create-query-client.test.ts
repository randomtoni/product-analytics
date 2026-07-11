import type { DefaultTaxonomyShape, ShapeOf } from '@randomtoni/analytics-kit';
import { defineTaxonomy } from '@randomtoni/analytics-kit';
import { afterEach, expect, expectTypeOf, test, vi } from 'vitest';
import { createQueryClient } from './create-query-client';
import type { QueryClientConfig } from './config';
import { HttpQueryAdapter } from './http-query-adapter';
import type { AnalyticsQueryClient } from './query-client';
import { QueryNoop } from './query-noop';

const taxonomy = defineTaxonomy({
  events: { order_placed: { amount: 'number' }, signed_up: {} },
  traits: { plan: 'string' },
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('createQueryClient({}) yields the QueryNoop null-object client', () => {
  const client = createQueryClient({});
  expect(client).toBeInstanceOf(QueryNoop);
});

test('unkeyed: every method resolves to a well-formed empty QueryResult (not throw/undefined)', async () => {
  const client = createQueryClient({ taxonomy });

  const funnel = await client.funnel({ steps: ['signed_up', 'order_placed'], within: { value: 7, unit: 'day' } });
  const retention = await client.retention({
    cohortEvent: 'signed_up',
    returnEvent: 'order_placed',
    periods: 4,
    granularity: 'week',
  });
  const trend = await client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 30, unit: 'day' } });
  const uniqueCount = await client.uniqueCount({ event: 'order_placed', window: { value: 1, unit: 'month' } });
  const raw = await client.rawQuery('SELECT count() FROM events');

  for (const result of [funnel, retention, trend, uniqueCount, raw]) {
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual([]);
    expect(typeof result.generatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);
  }
});

test('unkeyed: never touches the injected fetch — zero invocations (bar B)', async () => {
  const fetchSpy = vi.fn(async () => ({ status: 200 }) as never);
  const client = createQueryClient({
    taxonomy,
    queryEndpoint: 'https://query.example',
    fetch: fetchSpy as never,
  });

  await client.funnel({ steps: ['signed_up'], within: { value: 7, unit: 'day' } });
  await client.trend({ event: 'order_placed', aggregation: 'total', window: { value: 7, unit: 'day' } });
  await client.rawQuery('SELECT 1');

  expect(fetchSpy).not.toHaveBeenCalled();
});

test('distinct config surface: a query config carrying only personalKey is fully keyed for query', () => {
  // The query factory keys off `personalKey`, NOT the ingest `key`. A query config with a
  // personalKey (and no ingest `key` field even present) is keyed for query purposes; the
  // absence of a `queryEndpoint` takes the warn+no-op branch, proving personalKey was read.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = createQueryClient({ personalKey: 'pk_read' });

  expect(client).toBeInstanceOf(QueryNoop);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain('queryEndpoint');
});

test('distinct config surface: an ingest-style `key` on the config does NOT key the query client', () => {
  // Passing an ingest write `key` (not a query field) must NOT be mistaken for a personalKey.
  // With no personalKey, the query client stays a silent no-op and never warns.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = createQueryClient({ key: 'ingest_write_key' } as QueryClientConfig);

  expect(client).toBeInstanceOf(QueryNoop);
  expect(warn).not.toHaveBeenCalled();
});

test('distinct config surface: QueryClientConfig has no ingest key/host fields on its own surface', () => {
  // `key` / `ingestHost` are NOT part of the query config; assigning them is a type error.
  // @ts-expect-error `key` is the ingest write key — not part of the query config surface
  const _withIngestKey: QueryClientConfig = { personalKey: 'pk', key: 'ingest' };
  // @ts-expect-error `ingestHost` is the ingest host — not part of the query config surface
  const _withIngestHost: QueryClientConfig = { personalKey: 'pk', ingestHost: 'https://ingest.example' };
  void _withIngestKey;
  void _withIngestHost;
  expect(true).toBe(true);
});

test('keyed with no queryEndpoint warns exactly once and returns a safe no-op', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = createQueryClient({ personalKey: 'pk', taxonomy });

  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain('queryEndpoint');
  expect(client).toBeInstanceOf(QueryNoop);
});

test('keyed-but-endpointless: the safe no-op never POSTs to a host-less URL', async () => {
  const fetchSpy = vi.fn(async () => ({ status: 200 }) as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = createQueryClient({ personalKey: 'pk', fetch: fetchSpy as never });

  await client.rawQuery('SELECT 1');

  expect(fetchSpy).not.toHaveBeenCalled();
});

test('keyed WITH queryEndpoint does not warn and returns the REAL HTTP adapter (not QueryNoop)', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = createQueryClient({ personalKey: 'pk', queryEndpoint: 'https://query.example', projectId: 'proj-1', taxonomy });

  expect(warn).not.toHaveBeenCalled();
  expect(client).toBeInstanceOf(HttpQueryAdapter);
  expect(client).not.toBeInstanceOf(QueryNoop);
});

test('keyed + endpointed: a query POSTs to the endpoint via the injected fetch (real adapter wired in)', async () => {
  const fetchSpy = vi.fn(async () => ({
    status: 200,
    json: async () => ({ results: [], columns: [], types: [] }),
  }));
  const client = createQueryClient({
    personalKey: 'pk_read',
    queryEndpoint: 'https://query.example',
    projectId: 'proj-7',
    taxonomy,
    fetch: fetchSpy as never,
  });

  await client.rawQuery('SELECT 1');

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string> }];
  expect(url).toBe('https://query.example/api/projects/proj-7/query/');
  expect(init.method).toBe('POST');
  expect(init.headers['Authorization']).toBe('Bearer pk_read');
});

test('keyed + endpointed but NO projectId warns once (malformed URL) yet still returns the real adapter', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = createQueryClient({ personalKey: 'pk', queryEndpoint: 'https://query.example', taxonomy });

  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain('projectId');
  // A misconfig is the consumer's to see — it warns, it does NOT downgrade to a no-op.
  expect(client).toBeInstanceOf(HttpQueryAdapter);
  expect(client).not.toBeInstanceOf(QueryNoop);
});

test('keyed + endpointed with an EMPTY-string projectId also warns (malformed URL segment)', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  createQueryClient({ personalKey: 'pk', queryEndpoint: 'https://query.example', projectId: '', taxonomy });

  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain('projectId');
});

test('keyed + endpointed WITH a projectId does NOT warn', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  createQueryClient({ personalKey: 'pk', queryEndpoint: 'https://query.example', projectId: 'proj-9', taxonomy });

  expect(warn).not.toHaveBeenCalled();
});

test('the unkeyed no-op path does not warn (nothing is ever queried)', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  createQueryClient({ taxonomy });

  expect(warn).not.toHaveBeenCalled();
});

test('taxonomy overload returns AnalyticsQueryClient<ShapeOf<T>>; bare widens to DefaultTaxonomyShape', () => {
  const typed = createQueryClient({ taxonomy });
  expectTypeOf(typed).toEqualTypeOf<AnalyticsQueryClient<ShapeOf<(typeof taxonomy)['decl']>>>();

  const bare = createQueryClient({});
  expectTypeOf(bare).toEqualTypeOf<AnalyticsQueryClient<DefaultTaxonomyShape>>();

  // Specs type-check off the consumer's taxonomy — declared event names are accepted.
  void typed.funnel({ steps: ['signed_up', 'order_placed'], within: { value: 7, unit: 'day' } });
  void typed.trend({ event: 'order_placed', aggregation: 'total', window: { value: 7, unit: 'day' } });

  // @ts-expect-error 'checkout' is not a declared event on this taxonomy
  void typed.funnel({ steps: ['checkout'], within: { value: 7, unit: 'day' } });

  expect(typeof typed.funnel).toBe('function');
});

test('QueryNoop structurally satisfies AnalyticsQueryClient and never throws', async () => {
  const noop: AnalyticsQueryClient<DefaultTaxonomyShape> = new QueryNoop<DefaultTaxonomyShape>();

  await expect(noop.funnel({ steps: [], within: { value: 1, unit: 'day' } })).resolves.toMatchObject({
    rows: [],
    columns: [],
  });
  await expect(noop.rawQuery('anything')).resolves.toMatchObject({ rows: [], columns: [] });
});
