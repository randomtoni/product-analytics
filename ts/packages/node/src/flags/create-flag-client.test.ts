import type { DefaultTaxonomyShape, FeatureFlagPort, ShapeOf } from 'analytics-kit';
import { defineTaxonomy } from 'analytics-kit';
import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest';
import { createFlagClient } from './create-flag-client';
import type { NodeFlagClient } from './create-flag-client';
import type { FlagClientConfig } from './config';
import { FlagNoop } from './flag-noop';
import { HttpFlagAdapter } from './http-flag-adapter';

const taxonomy = defineTaxonomy({
  events: { order_placed: { amount: 'number' }, signed_up: {} },
  flags: {
    checkout_variant: { variants: ['a', 'b'], payload: { discount: 'number' } },
    dark_mode: {},
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('createFlagClient({}) yields the FlagNoop null-object client', () => {
  const client = createFlagClient({});
  expect(client).toBeInstanceOf(FlagNoop);
});

test('unkeyed: evaluate resolves the seam empty snapshot (not throw/undefined) — bar B', async () => {
  const client = createFlagClient({ taxonomy });

  const set = await client.evaluate({ distinctId: 'u1' });

  expect(set.isEnabled('anything')).toBe(false);
  expect(set.getFlag('anything')).toBeUndefined();
  expect(set.getAll()).toEqual({});
  expect(set.degraded).toBe(true);
});

test('unkeyed: never touches the injected fetch — zero invocations (bar B)', async () => {
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as never);
  const client = createFlagClient({
    taxonomy,
    flagEndpoint: 'https://flags.example',
    fetch: fetchSpy as never,
  });

  await client.evaluate({ distinctId: 'u1' });

  expect(fetchSpy).not.toHaveBeenCalled();
});

test('an ingest-style config with no key stays a silent no-op and never warns', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = createFlagClient({ taxonomy });

  expect(client).toBeInstanceOf(FlagNoop);
  expect(warn).not.toHaveBeenCalled();
});

test('keyed with no flagEndpoint warns exactly once and returns a safe no-op', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = createFlagClient({ key: 'k', taxonomy });

  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain('flagEndpoint');
  expect(client).toBeInstanceOf(FlagNoop);
});

test('keyed-but-endpointless: the safe no-op never POSTs to a host-less URL', async () => {
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = createFlagClient({ key: 'k', fetch: fetchSpy as never });

  await client.evaluate({ distinctId: 'u1' });

  expect(fetchSpy).not.toHaveBeenCalled();
});

test('keyed + endpointed returns the REAL remote adapter (not FlagNoop) and does not warn', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = createFlagClient({ key: 'k', flagEndpoint: 'https://flags.example', taxonomy });

  expect(warn).not.toHaveBeenCalled();
  expect(client).toBeInstanceOf(HttpFlagAdapter);
  expect(client).not.toBeInstanceOf(FlagNoop);
});

test('keyed + endpointed: an evaluate POSTs to the flag path via the injected fetch', async () => {
  const fetchSpy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ featureFlags: { dark_mode: true }, featureFlagPayloads: {} }),
  }));
  const client = createFlagClient({
    key: 'k_project',
    flagEndpoint: 'https://flags.example',
    taxonomy,
    fetch: fetchSpy as never,
  });

  await client.evaluate({ distinctId: 'u_7' });

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, { method: string; body: string }];
  expect(url).toBe('https://flags.example/flags/');
  expect(init.method).toBe('POST');
  const body = JSON.parse(init.body) as Record<string, unknown>;
  expect(body['token']).toBe('k_project');
  expect(body['distinct_id']).toBe('u_7');
});

test('taxonomy overload returns NodeFlagClient<ShapeOf<T>> (neutral port + stop); bare widens to DefaultTaxonomyShape', () => {
  const typed = createFlagClient({ key: 'k', flagEndpoint: 'https://flags.example', taxonomy });
  expectTypeOf(typed).toEqualTypeOf<NodeFlagClient<ShapeOf<(typeof taxonomy)['decl']>>>();

  const bare = createFlagClient({});
  expectTypeOf(bare).toEqualTypeOf<NodeFlagClient<DefaultTaxonomyShape>>();

  // The node client stays assignable to the neutral FeatureFlagPort — stop() is ADDITIVE, so the
  // vendor-neutral seam is still satisfied (a consumer can hold it as a plain FeatureFlagPort).
  expectTypeOf(typed).toMatchTypeOf<FeatureFlagPort<ShapeOf<(typeof taxonomy)['decl']>>>();

  expect(typeof typed.evaluate).toBe('function');
  expect(typeof typed.stop).toBe('function');
});

test('FlagClientConfig has no query-style personalKey/queryEndpoint on its own surface', () => {
  // The flag config is DISTINCT from the query config — a flag round-trip has its own endpoint.
  // @ts-expect-error `personalKey` is the query read key — not part of the flag config surface
  const _withPersonalKey: FlagClientConfig = { key: 'k', personalKey: 'pk' };
  // @ts-expect-error `queryEndpoint` is the query endpoint — not part of the flag config surface
  const _withQueryEndpoint: FlagClientConfig = { key: 'k', queryEndpoint: 'https://q.example' };
  void _withPersonalKey;
  void _withQueryEndpoint;
  expect(true).toBe(true);
});

test('local-capable: key + definitionsEndpoint + definitionsKey selects the real adapter (bar B)', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = createFlagClient({
    key: 'k',
    flagEndpoint: 'https://flags.example',
    definitionsEndpoint: 'https://flags.example',
    definitionsKey: 'k_privileged',
    taxonomy,
  });

  expect(warn).not.toHaveBeenCalled();
  expect(client).toBeInstanceOf(HttpFlagAdapter);
  expect(client).not.toBeInstanceOf(FlagNoop);
});

test('local-ONLY posture: key + definitionsEndpoint + definitionsKey with NO flagEndpoint is local-capable, NOT a no-op', () => {
  // The factory edge — a local-only consumer supplies no remote flagEndpoint. Branch (b)'s
  // warn→FlagNoop must NOT swallow this: a definitions route is a real place to evaluate.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = createFlagClient({
    key: 'k',
    definitionsEndpoint: 'https://flags.example',
    definitionsKey: 'k_privileged',
    onlyEvaluateLocally: true,
    taxonomy,
  });

  expect(warn).not.toHaveBeenCalled();
  expect(client).toBeInstanceOf(HttpFlagAdapter);
  expect(client).not.toBeInstanceOf(FlagNoop);
});

test('keyed with NEITHER a flagEndpoint NOR a definitionsEndpoint still warns once and no-ops', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const client = createFlagClient({ key: 'k', taxonomy });

  expect(warn).toHaveBeenCalledTimes(1);
  expect(client).toBeInstanceOf(FlagNoop);
});

test('a definitionsEndpoint WITHOUT the privileged credential is not local-capable (falls to the remote branch)', () => {
  // Missing definitionsKey ⇒ no local capability. With a remote flagEndpoint it stays remote-only;
  // without one it warns→no-op (nowhere to go).
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const remoteOnly = createFlagClient({
    key: 'k',
    flagEndpoint: 'https://flags.example',
    definitionsEndpoint: 'https://flags.example',
    taxonomy,
  });
  expect(remoteOnly).toBeInstanceOf(HttpFlagAdapter);

  const noRoute = createFlagClient({ key: 'k', definitionsEndpoint: 'https://flags.example', taxonomy });
  expect(noRoute).toBeInstanceOf(FlagNoop);
  expect(warn).toHaveBeenCalledTimes(1);
});

test('the local-eval knobs live on FlagClientConfig, never on the neutral port', () => {
  const _cfg: FlagClientConfig = {
    key: 'k',
    definitionsEndpoint: 'https://flags.example',
    definitionsKey: 'k_privileged',
    pollInterval: 10_000,
    onlyEvaluateLocally: true,
  };
  void _cfg;
  expect(true).toBe(true);
});

describe('stop() releases the background poller (a short-lived process can exit)', () => {
  function okResponse(body: unknown) {
    return { ok: true, status: 200, json: async () => body };
  }
  const DEFS = { flags: [{ key: 'a', active: true, filters: { groups: [{ properties: [], rollout_percentage: 100 }] } }] };

  // Spy on the fake-timer handle's unref so we can assert the poller unref'd its reschedule timer,
  // mirroring batch-queue.test.ts's timer-unref proof.
  function spyUnref() {
    const unref = vi.fn();
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, timeout?: number) => {
      const handle = original(handler, timeout) as unknown as { unref?: () => void };
      handle.unref = unref;
      return handle as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    return { unref };
  }

  test('a local-capable client exposes stop(); calling it schedules no further definition loads', async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.fn(async () => okResponse(DEFS));
      const client = createFlagClient({
        key: 'k',
        definitionsEndpoint: 'https://flags.example',
        definitionsKey: 'k_privileged',
        pollInterval: 5000,
        fetch: fetchSpy as never,
      });

      // stop() is on the node return type (not the neutral port).
      expect(typeof client.stop).toBe('function');

      // The constructor fired the first definition load; let it settle.
      await vi.advanceTimersByTimeAsync(0);
      const loadsBeforeStop = fetchSpy.mock.calls.length;
      expect(loadsBeforeStop).toBeGreaterThanOrEqual(1);

      client.stop();
      // After stop(), advancing well past the poll interval schedules no further load.
      await vi.advanceTimersByTimeAsync(50000);
      expect(fetchSpy).toHaveBeenCalledTimes(loadsBeforeStop);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the reschedule timer is unref\'d so a captured-then-exited process is not held open', async () => {
    vi.useFakeTimers();
    try {
      const { unref } = spyUnref();
      const fetchSpy = vi.fn(async () => okResponse(DEFS));
      const client = createFlagClient({
        key: 'k',
        definitionsEndpoint: 'https://flags.example',
        definitionsKey: 'k_privileged',
        pollInterval: 5000,
        fetch: fetchSpy as never,
      });

      // Settle the first load; scheduling the next poll unref's its timer.
      await vi.advanceTimersByTimeAsync(0);
      expect(unref).toHaveBeenCalled();

      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('the no-op flag client also honors stop() (an unconfigured env releases cleanly)', () => {
    const noop = createFlagClient({});
    expect(noop).toBeInstanceOf(FlagNoop);
    expect(() => noop.stop()).not.toThrow();
  });
});
