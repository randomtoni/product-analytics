import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DefinitionPoller, type DefinitionPollerConfig } from './definition-poller';
import type { FlagDefinition } from './definition-types';

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

const SIMPLE_DEFS = {
  flags: [
    { key: 'a', active: true, filters: { groups: [{ properties: [], rollout_percentage: 100 }] } },
  ] as FlagDefinition[],
  group_type_mapping: { '0': 'org' },
  cohorts: { c1: { type: 'AND', values: [] } },
};

function makePoller(
  fetchImpl: (url: string, init: unknown) => Promise<unknown>,
  over: Partial<DefinitionPollerConfig> = {}
): DefinitionPoller {
  return new DefinitionPoller({
    definitionsEndpoint: 'https://flags.example',
    definitionsKey: 'k_privileged',
    token: 'k_project',
    pollIntervalMs: 30000,
    fetch: fetchImpl as never,
    ...over,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('immediate first load', () => {
  test('start() loads definitions on the first tick and parses the snapshot', async () => {
    const fetchSpy = vi.fn(async () => okResponse(SIMPLE_DEFS));
    const poller = makePoller(fetchSpy as never);

    expect(poller.isReady()).toBe(false);
    await poller.start();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(poller.isReady()).toBe(true);
    const snap = poller.getSnapshot();
    expect(snap.flags).toHaveLength(1);
    expect(snap.flagsByKey['a']).toBeDefined();
    expect(snap.groupTypeMapping).toEqual({ '0': 'org' });
    expect(snap.cohorts).toHaveProperty('c1');

    poller.stop();
  });

  test('the fetch targets the definitions endpoint with the privileged credential + token', async () => {
    let capturedUrl = '';
    let capturedInit: { headers: Record<string, string> } | undefined;
    const poller = makePoller(async (url, init) => {
      capturedUrl = url as string;
      capturedInit = init as { headers: Record<string, string> };
      return okResponse(SIMPLE_DEFS);
    });
    await poller.start();

    expect(capturedUrl).toContain('/flags/definitions');
    expect(capturedUrl).toContain('token=k_project');
    expect(capturedUrl).toContain('send_cohorts');
    expect(capturedInit?.headers.Authorization).toBe('Bearer k_privileged');

    poller.stop();
  });

  test('before the first load the snapshot is the frozen empty snapshot (never crashes a read)', () => {
    const poller = makePoller(async () => okResponse(SIMPLE_DEFS));
    const snap = poller.getSnapshot();
    expect(snap.flags).toEqual([]);
    expect(snap.flagsByKey).toEqual({});
    poller.stop();
  });
});

describe('reschedule at the configured interval', () => {
  test('a second load fires after the poll interval elapses', async () => {
    const fetchSpy = vi.fn(async () => okResponse(SIMPLE_DEFS));
    const poller = makePoller(fetchSpy as never, { pollIntervalMs: 5000 });

    await poller.start();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    poller.stop();
  });
});

describe('in-flight dedup', () => {
  test('concurrent loads share a single in-flight request', async () => {
    let resolveFetch: ((v: unknown) => void) | undefined;
    const fetchSpy = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );
    const poller = makePoller(fetchSpy as never);

    const p1 = poller.start();
    const p2 = poller.start();
    // Both calls collapse onto one fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolveFetch?.(okResponse(SIMPLE_DEFS));
    await Promise.all([p1, p2]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    poller.stop();
  });
});

describe('stop() halts polling', () => {
  test('after stop() no further loads are scheduled', async () => {
    const fetchSpy = vi.fn(async () => okResponse(SIMPLE_DEFS));
    const poller = makePoller(fetchSpy as never, { pollIntervalMs: 5000 });

    await poller.start();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    poller.stop();
    await vi.advanceTimersByTimeAsync(50000);

    // No reschedule fired after stop.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('stop() is idempotent (no throw when called twice or before start)', () => {
    const poller = makePoller(async () => okResponse(SIMPLE_DEFS));
    expect(() => {
      poller.stop();
      poller.stop();
    }).not.toThrow();
  });
});

describe('failed load leaves prior good data in place', () => {
  test('a non-2xx response does not overwrite a previously-loaded snapshot', async () => {
    let ok = true;
    const poller = makePoller(
      async () => (ok ? okResponse(SIMPLE_DEFS) : { ok: false, status: 500, json: async () => ({}) }),
      { pollIntervalMs: 5000 }
    );

    await poller.start();
    expect(poller.isReady()).toBe(true);

    ok = false;
    await vi.advanceTimersByTimeAsync(5000);

    // The failed refresh kept the good snapshot.
    expect(poller.isReady()).toBe(true);
    expect(poller.getSnapshot().flags).toHaveLength(1);

    poller.stop();
  });

  test('a thrown fetch error is swallowed and leaves the poller running', async () => {
    let shouldThrow = false;
    const poller = makePoller(
      async () => {
        if (shouldThrow) {
          throw new Error('network down');
        }
        return okResponse(SIMPLE_DEFS);
      },
      { pollIntervalMs: 5000 }
    );

    await poller.start();
    shouldThrow = true;
    // The thrown fetch error is swallowed — advancing the timer does not reject.
    await vi.advanceTimersByTimeAsync(5000);
    expect(poller.getSnapshot().flags).toHaveLength(1);

    poller.stop();
  });
});

describe('isReady gates on a non-empty definition list', () => {
  test('a successful load of zero flags is not ready', async () => {
    const poller = makePoller(async () => okResponse({ flags: [], group_type_mapping: {}, cohorts: {} }));
    await poller.start();
    expect(poller.isReady()).toBe(false);
    poller.stop();
  });
});
