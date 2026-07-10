import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReplayEvent } from './replay';
import { createReplayDelivery } from './replay-transport';

const REPLAY_URL = 'https://analytics.example.com/s/';

function fakeEvents(...tags: number[]): ReplayEvent[] {
  return tags.map((t) => ({ type: 3, data: {}, timestamp: t }) as unknown as ReplayEvent);
}

// Flush the microtask queue so the async fetch delivery path settles before assertions.
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('replay delivery — fetch POST to the replay path (E14-S4)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
  });

  test('POSTs the buffered events to the REPLAY path with the session tag in the wire body', async () => {
    // compression:false forces the uncompressed-JSON path so the wire BODY is a readable JSON
    // string a test can inspect for the snapshots + session tag.
    const delivery = createReplayDelivery(REPLAY_URL, false);

    delivery.send(fakeEvents(1, 2), 'session-xyz', false);
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The delivery path is the replay path — NOT the capture /batch/ path.
    expect(url).toBe(REPLAY_URL);
    expect(url).not.toContain('/batch/');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as { events: unknown[]; session_id: string };
    // The wire body carries the buffered snapshots + the getReplayId session tag.
    expect(body.events).toHaveLength(2);
    expect(body.session_id).toBe('session-xyz');
  });

  test('an empty buffer sends nothing (no POST)', async () => {
    const delivery = createReplayDelivery(REPLAY_URL, false);

    delivery.send([], 'session-xyz', false);
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('no configured replay URL sends nothing (a no-delivery client)', async () => {
    const delivery = createReplayDelivery(undefined, false);

    delivery.send(fakeEvents(1), 'session-xyz', false);
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a fetch rejection is swallowed (replay is best-effort — no throw escapes)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const delivery = createReplayDelivery(REPLAY_URL, false);

    // send is fire-and-forget; a rejected POST must not throw or leave an unhandled rejection.
    expect(() => delivery.send(fakeEvents(1), 'session-xyz', false)).not.toThrow();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('replay delivery — gzip compression (E14-S4)', () => {
  test('a compressed POST rides the binary fetch path with the [WIRE] compression params', async () => {
    // compression:true (native gzip runs in node's CompressionStream) → binary body to the
    // direct DOM fetch with the [WIRE] compression=/ver=/_= params appended.
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const delivery = createReplayDelivery(REPLAY_URL, true);
    delivery.send(fakeEvents(1, 2, 3), 'session-gz', false);
    // Native gzip is async (CompressionStream + validation spans several ticks); wait for the
    // POST rather than a fixed delay so the compressed body has resolved.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The compressed body is binary; the compression marker rides the replay URL's query.
    expect(url).toContain('/s/');
    expect(url).toContain('compression=');
    expect(init.body).toBeInstanceOf(ArrayBuffer);
  });
});

describe('replay delivery — teardown beacon path (E14-S4)', () => {
  test('a keepalive (teardown) flush uses sendBeacon, not fetch, on the replay path', async () => {
    const beacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    // compression:false → the beacon body is a readable JSON string.
    const delivery = createReplayDelivery(REPLAY_URL, false);
    delivery.send(fakeEvents(1), 'session-teardown', true);
    await settle();

    // The teardown flush rides sendBeacon (survives the closing page) — NOT the async fetch.
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    const [url, blob] = beacon.mock.calls[0] as [string, Blob];
    // Delivered on the replay path (not /batch/) via a Blob (so the Content-Type is set). The
    // body's JSON shape is asserted on the fetch path above — jsdom's Blob text read is unreliable.
    expect(url).toContain('/s/');
    expect(url).not.toContain('/batch/');
    expect(blob).toBeInstanceOf(Blob);
  });
});
