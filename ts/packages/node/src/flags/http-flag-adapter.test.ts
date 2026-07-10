import type { DefaultTaxonomyShape, FlagSet } from 'analytics-kit';
import { describe, expect, test, vi } from 'vitest';
import { HttpFlagAdapter } from './http-flag-adapter';

interface WireBody {
  token: string;
  distinct_id: string;
  groups?: Record<string, string>;
  person_properties?: Record<string, unknown>;
  group_properties?: Record<string, Record<string, unknown>>;
  flag_keys_to_evaluate?: readonly string[];
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function makeAdapter(
  fetchImpl: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>,
  opts?: { bootstrap?: { flags?: Record<string, string | boolean>; payloads?: Record<string, unknown> } }
): HttpFlagAdapter<DefaultTaxonomyShape> {
  return new HttpFlagAdapter<DefaultTaxonomyShape>({
    key: 'k_project',
    flagEndpoint: 'https://flags.example',
    bootstrap: opts?.bootstrap,
    fetch: fetchImpl as never,
  });
}

describe('distinctId required + validated', () => {
  test('evaluate with NO distinctId throws a clear neutral error and fires no fetch', async () => {
    const fetchSpy = vi.fn(async () => okResponse({}));
    const adapter = makeAdapter(fetchSpy as never);

    await expect(adapter.evaluate({})).rejects.toThrow(/distinctId is required/);
    await expect(adapter.evaluate(undefined)).rejects.toThrow(/distinctId is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('the neutral error message carries NO vendor token', async () => {
    const adapter = makeAdapter(async () => okResponse({}));
    let message = '';
    try {
      await adapter.evaluate({ distinctId: '' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.toLowerCase()).not.toContain('posthog');
    expect(message.toLowerCase()).not.toContain('flags/');
    // Symmetry: the message names the NEUTRAL field only — never the [WIRE] request-body keys.
    expect(message.toLowerCase()).not.toContain('token');
    expect(message.toLowerCase()).not.toContain('distinct_id');
  });

  test('an empty-string distinctId is treated as absent (throws)', async () => {
    const fetchSpy = vi.fn(async () => okResponse({}));
    const adapter = makeAdapter(fetchSpy as never);

    await expect(adapter.evaluate({ distinctId: '' })).rejects.toThrow(/distinctId is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('evaluate resolves the snapshot via the round-trip', () => {
  test('a keyed evaluate resolves the resolved FlagSet with reason "resolved" and degraded false', async () => {
    const adapter = makeAdapter(async () =>
      okResponse({
        featureFlags: { beta_banner: true, checkout: 'a' },
        featureFlagPayloads: { checkout: { discount: 10 } },
      })
    );

    const set = await adapter.evaluate({ distinctId: 'u_1' });

    expect(set.isEnabled('beta_banner')).toBe(true);
    expect(set.getFlag('checkout')).toBe('a');
    expect(set.getPayload('checkout')).toEqual({ discount: 10 });
    expect(set.getAll()).toEqual({ beta_banner: true, checkout: 'a' });
    expect(set.degraded).toBe(false);
    expect(set.reason('checkout')).toBe('resolved');
  });

  test('the wire body carries this actor and the full FlagContext, token in-body', async () => {
    let captured: WireBody | undefined;
    const adapter = makeAdapter(async (_url, init) => {
      captured = JSON.parse(init.body) as WireBody;
      return okResponse({ featureFlags: {}, featureFlagPayloads: {} });
    });

    await adapter.evaluate({
      distinctId: 'u_9',
      groups: { org: 'acme' },
      personProperties: { plan: 'pro' },
      groupProperties: { org: { tier: 'gold' } },
      flagKeys: ['beta_banner'],
    });

    expect(captured).toEqual({
      token: 'k_project',
      distinct_id: 'u_9',
      groups: { org: 'acme' },
      person_properties: { plan: 'pro' },
      group_properties: { org: { tier: 'gold' } },
      flag_keys_to_evaluate: ['beta_banner'],
    });
  });

  test('isEnabled distinguishes off (false) from missing; getFlag distinguishes undefined from false', async () => {
    const adapter = makeAdapter(async () =>
      okResponse({ featureFlags: { on: true, off: false }, featureFlagPayloads: {} })
    );

    const set = await adapter.evaluate({ distinctId: 'u_1' });

    expect(set.isEnabled('on')).toBe(true);
    expect(set.isEnabled('off')).toBe(false);
    expect(set.isEnabled('missing')).toBe(false);
    expect(set.getFlag('off')).toBe(false);
    expect(set.getFlag('missing')).toBeUndefined();
    expect(set.reason('missing')).toBeUndefined();
  });
});

describe('per-call fetch — no shared wire body across differing contexts (S2 warning)', () => {
  test('two evaluates with different distinctIds issue two independent round-trips', async () => {
    const bodies: WireBody[] = [];
    const adapter = makeAdapter(async (_url, init) => {
      bodies.push(JSON.parse(init.body) as WireBody);
      return okResponse({ featureFlags: {}, featureFlagPayloads: {} });
    });

    await adapter.evaluate({ distinctId: 'alice' });
    await adapter.evaluate({ distinctId: 'bob', personProperties: { plan: 'pro' } });

    expect(bodies).toHaveLength(2);
    expect(bodies[0].distinct_id).toBe('alice');
    expect(bodies[1].distinct_id).toBe('bob');
    expect(bodies[1].person_properties).toEqual({ plan: 'pro' });
    // The second actor's body must NOT be answered from the first's request.
    expect(bodies[0].person_properties).toBeUndefined();
  });

  test('concurrent evaluates for different actors each get their own body (no coalescing)', async () => {
    const bodies: WireBody[] = [];
    const adapter = makeAdapter(async (_url, init) => {
      bodies.push(JSON.parse(init.body) as WireBody);
      await new Promise((r) => setTimeout(r, 0));
      return okResponse({ featureFlags: {}, featureFlagPayloads: {} });
    });

    await Promise.all([
      adapter.evaluate({ distinctId: 'alice' }),
      adapter.evaluate({ distinctId: 'bob' }),
    ]);

    expect(bodies.map((b) => b.distinct_id).sort()).toEqual(['alice', 'bob']);
  });
});

describe('onChange fires once (server degenerate cardinality)', () => {
  test('a listener registered before the first evaluate fires exactly once, never re-firing', async () => {
    const adapter = makeAdapter(async () =>
      okResponse({ featureFlags: { v: 'x' }, featureFlagPayloads: {} })
    );
    const seen: Array<FlagSet<DefaultTaxonomyShape>> = [];
    adapter.onChange((set) => seen.push(set));

    await adapter.evaluate({ distinctId: 'u_1' });
    await adapter.evaluate({ distinctId: 'u_2' });
    await adapter.evaluate({ distinctId: 'u_3' });

    expect(seen).toHaveLength(1);
    expect(seen[0].getFlag('v')).toBe('x');
  });

  test('a listener registered AFTER the first evaluate still receives the resolved set once', async () => {
    const adapter = makeAdapter(async () =>
      okResponse({ featureFlags: { v: 'x' }, featureFlagPayloads: {} })
    );
    await adapter.evaluate({ distinctId: 'u_1' });

    const seen: Array<FlagSet<DefaultTaxonomyShape>> = [];
    adapter.onChange((set) => seen.push(set));

    expect(seen).toHaveLength(1);
    expect(seen[0].getFlag('v')).toBe('x');
  });

  test('the unsubscribe returned is sound — no throw, and no second fire after it', async () => {
    const adapter = makeAdapter(async () =>
      okResponse({ featureFlags: { v: 'x' }, featureFlagPayloads: {} })
    );
    const seen: number[] = [];
    const unsubscribe = adapter.onChange(() => seen.push(1));

    expect(() => unsubscribe()).not.toThrow();

    await adapter.evaluate({ distinctId: 'u_1' });
    await adapter.evaluate({ distinctId: 'u_2' });

    // Unsubscribed before the fire ⇒ never called; a second evaluate never re-fires anyway.
    expect(seen).toHaveLength(0);
  });
});

describe('degradation signal on a failed round-trip', () => {
  test('a non-2xx status sets degraded true + reason unresolved (empty set, no seed)', async () => {
    const adapter = makeAdapter(async () => ({ ok: false, status: 500, json: async () => ({}) }));

    const set = await adapter.evaluate({ distinctId: 'u_1' });

    expect(set.degraded).toBe(true);
    expect(set.getFlag('anything')).toBeUndefined();
    expect(set.isEnabled('anything')).toBe(false);
    expect(set.reason('anything')).toBeUndefined();
  });

  test('a thrown network error degrades to unresolved rather than propagating', async () => {
    const adapter = makeAdapter(async () => {
      throw new Error('boom');
    });

    const set = await adapter.evaluate({ distinctId: 'u_1' });

    expect(set.degraded).toBe(true);
    expect(set.getAll()).toEqual({});
  });

  test('a failed round-trip with a bootstrap seed serves the seed marked stale (degraded)', async () => {
    const adapter = makeAdapter(async () => ({ ok: false, status: 503, json: async () => ({}) }), {
      bootstrap: { flags: { gate: true }, payloads: { gate: { note: 'seed' } } },
    });

    const set = await adapter.evaluate({ distinctId: 'u_1' });

    expect(set.getFlag('gate')).toBe(true);
    expect(set.getPayload('gate')).toEqual({ note: 'seed' });
    expect(set.degraded).toBe(true);
    expect(set.reason('gate')).toBe('stale');
  });

  test('no vendor eval-quality field leaks onto the snapshot even when the response carries it', async () => {
    const adapter = makeAdapter(async () =>
      okResponse({
        featureFlags: { v: true },
        featureFlagPayloads: {},
        errorsWhileComputing: true,
        quotaLimited: ['feature_flags'],
        requestId: 'req-123',
      })
    );

    const set = await adapter.evaluate({ distinctId: 'u_1' });

    expect(set).not.toHaveProperty('errorsWhileComputing');
    expect(set).not.toHaveProperty('quotaLimited');
    expect(set).not.toHaveProperty('requestId');
    expect(Object.keys(set.getAll())).toEqual(['v']);
  });
});

describe('reading a flag triggers no capture (no $feature_flag_called)', () => {
  test('the fetch fires only on evaluate, never on a subsequent snapshot read', async () => {
    const fetchSpy = vi.fn(async () =>
      okResponse({ featureFlags: { v: true }, featureFlagPayloads: {} })
    );
    const adapter = makeAdapter(fetchSpy as never);

    const set = await adapter.evaluate({ distinctId: 'u_1' });
    set.isEnabled('v');
    set.getFlag('v');
    set.getPayload('v');
    set.getAll();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
