import { gunzipSync } from 'node:zlib';
import type { NeutralEvent } from 'analytics-kit';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { NodeAnalyticsConfig } from './config';
import { createSendBatch, type NodeFetch } from './send-batch';
import type { WireBatchEnvelope } from './wire-mapper';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

// A mock fetch whose status sequence is scripted per call. A `null` entry throws (a
// network error), which the transport wrapper surfaces as status 0. When the script is
// exhausted the last status repeats.
function mockFetch(statuses: (number | null)[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: NodeFetch = vi.fn(async (url, init) => {
    calls.push({ url, ...init });
    const status = i < statuses.length ? statuses[i] : statuses[statuses.length - 1];
    i++;
    if (status === null) {
      throw new Error('network down');
    }
    return { status };
  });
  return { fetchImpl, calls };
}

function decodeBody(body: string | Uint8Array): WireBatchEnvelope {
  if (typeof body === 'string') {
    return JSON.parse(body) as WireBatchEnvelope;
  }
  return JSON.parse(gunzipSync(body).toString('utf8')) as WireBatchEnvelope;
}

function events(...dedupeIds: string[]): NeutralEvent[] {
  return dedupeIds.map((dedupeId, idx) => ({
    event: 'order_placed',
    distinctId: 'user-1',
    properties: { amount: idx },
    timestamp: new Date('2026-07-08T00:00:00.000Z'),
    dedupeId,
  }));
}

const baseConfig: NodeAnalyticsConfig = {
  key: 'proj-key',
  ingestHost: 'https://ingest.example.test',
};

// A wait stub so the fixed retry delay resolves immediately under the loop without
// coupling to real or fake timers inside the retry await.
const immediateWait = async (): Promise<void> => {};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('envelope + endpoint', () => {
  test('POSTs a gzipped { api_key, batch, sent_at } envelope that round-trips via gunzip', async () => {
    const { fetchImpl, calls } = mockFetch([200]);
    const send = createSendBatch({ config: baseConfig, fetchImpl, wait: immediateWait });

    await send(events('dd-1', 'dd-2'));

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe('POST');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.headers['Content-Encoding']).toBe('gzip');
    expect(call.body).toBeInstanceOf(Uint8Array);

    const envelope = decodeBody(call.body);
    expect(envelope.api_key).toBe('proj-key');
    expect(typeof envelope.sent_at).toBe('string');
    expect(envelope.batch.map((e) => e.uuid)).toEqual(['dd-1', 'dd-2']);
    expect(envelope.batch[0].distinct_id).toBe('user-1');
  });

  test('POSTs to ingestHost + the adapter-internal /batch/ path when ingestPath is unset', async () => {
    const { fetchImpl, calls } = mockFetch([200]);
    const send = createSendBatch({ config: baseConfig, fetchImpl, wait: immediateWait });

    await send(events('dd-1'));
    expect(calls[0].url).toBe('https://ingest.example.test/batch/');
  });

  test('honours a consumer-supplied ingestPath override', async () => {
    const { fetchImpl, calls } = mockFetch([200]);
    const send = createSendBatch({
      config: { ...baseConfig, ingestPath: '/proxy/collect' },
      fetchImpl,
      wait: immediateWait,
    });

    await send(events('dd-1'));
    expect(calls[0].url).toBe('https://ingest.example.test/proxy/collect');
  });

  test('defaults no vendor host: an unset ingestHost yields a host-less path, never a vendor endpoint', async () => {
    const { fetchImpl, calls } = mockFetch([200]);
    const send = createSendBatch({ config: { key: 'k' }, fetchImpl, wait: immediateWait });

    await send(events('dd-1'));
    // No vendor host is ever synthesized: an unset ingestHost yields a bare host-less
    // path, never a `.com` / regional vendor endpoint.
    expect(calls[0].url).toBe('/batch/');
    expect(calls[0].url).not.toMatch(/https?:\/\//);
    expect(calls[0].url).not.toMatch(/\.(com|io|net)/i);
  });

  test('the emitted envelope carries no $insert_id anywhere', async () => {
    const { fetchImpl, calls } = mockFetch([200]);
    const send = createSendBatch({ config: baseConfig, fetchImpl, wait: immediateWait });

    await send(events('dd-1'));
    const raw = gunzipSync(calls[0].body as Uint8Array).toString('utf8');
    expect(raw).not.toContain('$insert_id');
  });
});

describe('413 halving', () => {
  test('a 413 halves the batch and re-sends the SAME records at the smaller size (not dropped)', async () => {
    // 4 records; maxBatchSize 4 → first POST is 4 records → 413 → halve to 2 → two POSTs of 2.
    const { fetchImpl, calls } = mockFetch([413, 200, 200]);
    const send = createSendBatch({
      config: { ...baseConfig, maxBatchSize: 4 },
      fetchImpl,
      wait: immediateWait,
    });

    await send(events('a', 'b', 'c', 'd'));

    // call 0: the 413'd batch of 4; calls 1 & 2: the halved 2 + 2.
    const sizes = calls.map((c) => decodeBody(c.body).batch.length);
    expect(sizes).toEqual([4, 2, 2]);

    // Every record is re-sent — none dropped. Union of the two 200 batches = all 4 uuids.
    const delivered = [...decodeBody(calls[1].body).batch, ...decodeBody(calls[2].body).batch].map(
      (e) => e.uuid
    );
    expect(delivered.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  test('413 floors the halved size at 1 and does not spin forever on a single oversized record', async () => {
    // 2 records, maxBatchSize 2 → 413 → halve to 1 → each single record still 413 → drop.
    const { fetchImpl, calls } = mockFetch([413, 413, 413]);
    const send = createSendBatch({
      config: { ...baseConfig, maxBatchSize: 2 },
      fetchImpl,
      wait: immediateWait,
    });

    await send(events('a', 'b'));

    const sizes = calls.map((c) => decodeBody(c.body).batch.length);
    // batch of 2 (413) → halve to 1 → single 'a' (413, dropped) → single 'b' (413, dropped).
    expect(sizes).toEqual([2, 1, 1]);
  });

  test('413 is NOT counted as a transient retry (no backoff wait for it)', async () => {
    const waitSpy = vi.fn(async () => {});
    const { fetchImpl } = mockFetch([413, 200, 200]);
    const send = createSendBatch({
      config: { ...baseConfig, maxBatchSize: 2 },
      fetchImpl,
      wait: waitSpy,
    });

    await send(events('a', 'b'));
    // 413-halving re-slices immediately; the retry backoff wait is only for transient statuses.
    expect(waitSpy).not.toHaveBeenCalled();
  });
});

describe('transient retry', () => {
  test('a transient 5xx retries within budget and succeeds (503 → 503 → 200)', async () => {
    const waitSpy = vi.fn(async () => {});
    const { fetchImpl, calls } = mockFetch([503, 503, 200]);
    const send = createSendBatch({ config: baseConfig, fetchImpl, wait: waitSpy });

    await send(events('a'));

    expect(calls).toHaveLength(3);
    expect(waitSpy).toHaveBeenCalledTimes(2);
    expect(waitSpy).toHaveBeenCalledWith(3000);
  });

  test.each([408, 429, 500, 502, 504])('status %i is transient and retried', async (status) => {
    const { fetchImpl, calls } = mockFetch([status, 200]);
    const send = createSendBatch({ config: baseConfig, fetchImpl, wait: immediateWait });

    await send(events('a'));
    expect(calls.length).toBeGreaterThan(1);
  });

  test('a network error (surfaced as status 0) is retried within budget', async () => {
    const { fetchImpl, calls } = mockFetch([null, null, 200]);
    const send = createSendBatch({ config: baseConfig, fetchImpl, wait: immediateWait });

    await send(events('a'));
    expect(calls).toHaveLength(3);
  });

  test('an unrecoverable transient failure exhausts the budget then gives up (resolves, records dropped)', async () => {
    const { fetchImpl, calls } = mockFetch([503]);
    const send = createSendBatch({ config: baseConfig, fetchImpl, wait: immediateWait });

    // Resolves on give-up (never rejects out to the queue).
    await expect(send(events('a'))).resolves.toBeUndefined();
    // Initial attempt + RETRY_COUNT (3) retries = 4 total.
    expect(calls).toHaveLength(4);
  });

  test('a non-413 4xx (e.g. 400) is permanent — dropped, not retried', async () => {
    const { fetchImpl, calls } = mockFetch([400, 200]);
    const send = createSendBatch({ config: baseConfig, fetchImpl, wait: immediateWait });

    await send(events('a'));
    expect(calls).toHaveLength(1); // no retry
  });

  test('a 401 auth failure is permanent — dropped, not retried', async () => {
    const { fetchImpl, calls } = mockFetch([401, 200]);
    const send = createSendBatch({ config: baseConfig, fetchImpl, wait: immediateWait });

    await send(events('a'));
    expect(calls).toHaveLength(1);
  });

  test('the retry backoff uses the real fixed 3000ms delay under fake timers', async () => {
    const { fetchImpl, calls } = mockFetch([503, 200]);
    // No `wait` override → the real setTimeout-based wait, driven by fake timers.
    const send = createSendBatch({ config: baseConfig, fetchImpl });

    const done = send(events('a'));
    await vi.advanceTimersByTimeAsync(2999);
    expect(calls).toHaveLength(1); // still waiting out the backoff
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(calls).toHaveLength(2);
  });
});

describe('gzip fallback', () => {
  test('falls back to raw JSON and omits Content-Encoding when gzip yields nothing', async () => {
    vi.resetModules();
    vi.doMock('./gzip', () => ({ gzip: () => Buffer.alloc(0) }));
    const { createSendBatch: createWithEmptyGzip } = await import('./send-batch');

    const { fetchImpl, calls } = mockFetch([200]);
    const send = createWithEmptyGzip({ config: baseConfig, fetchImpl, wait: immediateWait });
    await send(events('dd-1'));

    expect(typeof calls[0].body).toBe('string');
    expect(calls[0].headers['Content-Encoding']).toBeUndefined();
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].body as string).batch[0].uuid).toBe('dd-1');

    vi.doUnmock('./gzip');
    vi.resetModules();
  });
});

describe('injected vs global fetch (via createAnalytics)', () => {
  test('createAnalytics uses the injected config.fetch when supplied', async () => {
    const { createAnalytics } = await import('./create-analytics');
    const { fetchImpl, calls } = mockFetch([200]);

    const analytics = createAnalytics({
      ...baseConfig,
      flushAt: 1,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    analytics.capture('user-1', 'order_placed', { amount: 1 }, { dedupeId: 'dd-inj' });
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    expect(decodeBody(calls[0].body).batch[0].uuid).toBe('dd-inj');
  });

  test('createAnalytics falls back to the global fetch when none is injected', async () => {
    const { createAnalytics } = await import('./create-analytics');
    const globalSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ status: 200 } as Response);

    const analytics = createAnalytics({ ...baseConfig, flushAt: 1 });
    analytics.capture('user-1', 'order_placed', { amount: 1 }, { dedupeId: 'dd-global' });
    await vi.advanceTimersByTimeAsync(0);

    expect(globalSpy).toHaveBeenCalledTimes(1);
    expect(globalSpy.mock.calls[0][0]).toBe('https://ingest.example.test/batch/');
  });
});
