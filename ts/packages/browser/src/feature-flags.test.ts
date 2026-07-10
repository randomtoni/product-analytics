import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import {
  defineTaxonomy,
  emptyFlagSet,
  type FlagSet,
  type NeutralFetchResponse,
  type ShapeOf,
} from 'analytics-kit';
import { FlagClient, type FlagFetchOptions } from './feature-flags';

// A neutral fetch response over a fixed JSON body + status — the mock the flag adapter's own
// fetch SPI reference resolves to. `text` is unused by the flag adapter; `json` returns the body.
function jsonResponse(body: unknown, status = 200): NeutralFetchResponse {
  return {
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

// A controllable fetch: records each call and resolves with whatever the test queues. `resolve`
// lets a test hold the response un-resolved (the network-pending case) then release it.
function deferredFetch(): {
  fetch: (url: string, options: FlagFetchOptions) => Promise<NeutralFetchResponse>;
  calls: Array<{ url: string; options: FlagFetchOptions }>;
  resolveWith: (response: NeutralFetchResponse) => void;
  rejectWith: (error: unknown) => void;
} {
  const calls: Array<{ url: string; options: FlagFetchOptions }> = [];
  let resolveFn: (response: NeutralFetchResponse) => void = () => {};
  let rejectFn: (error: unknown) => void = () => {};
  const pending = new Promise<NeutralFetchResponse>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    fetch: (url, options) => {
      calls.push({ url, options });
      return pending;
    },
    calls,
    resolveWith: (response) => resolveFn(response),
    rejectWith: (error) => rejectFn(error),
  };
}

// A controllable fetch where EACH call gets its own independent deferred, so a test can hold
// call #1 pending while resolving call #2 (or vice versa) — needed to prove a forced refresh
// issues a distinct fetch rather than coalescing onto the first call's in-flight request.
function queuedFetch(): {
  fetch: (url: string, options: FlagFetchOptions) => Promise<NeutralFetchResponse>;
  calls: Array<{ url: string; options: FlagFetchOptions }>;
  resolveCall: (index: number, response: NeutralFetchResponse) => void;
} {
  const calls: Array<{ url: string; options: FlagFetchOptions }> = [];
  const resolvers: Array<(response: NeutralFetchResponse) => void> = [];
  return {
    fetch: (url, options) => {
      calls.push({ url, options });
      return new Promise<NeutralFetchResponse>((resolve) => {
        resolvers.push(resolve);
      });
    },
    calls,
    resolveCall: (index, response) => resolvers[index]?.(response),
  };
}

const HOST = 'https://analytics.example.com';

function makeClient(overrides?: {
  fetch?: (url: string, options: FlagFetchOptions) => Promise<NeutralFetchResponse>;
  bootstrap?: { flags?: Record<string, string | boolean>; payloads?: Record<string, unknown> };
  getDistinctId?: () => string;
  ingestHost?: string | undefined;
}): FlagClient {
  return new FlagClient({
    key: 'proj-key',
    // Honor an explicitly-passed `ingestHost: undefined` (the no-endpoint case), falling back to
    // the default host only when the key is absent from overrides entirely.
    ingestHost: overrides && 'ingestHost' in overrides ? overrides.ingestHost : HOST,
    bootstrap: overrides?.bootstrap,
    getDistinctId: overrides?.getDistinctId ?? (() => 'browser-identity-id'),
    fetch: overrides?.fetch ?? (async () => jsonResponse({ featureFlags: {}, featureFlagPayloads: {} })),
  });
}

describe('bootstrap synchronous seeding (AC: no flash-of-wrong-variant)', () => {
  test('first evaluate resolves to the bootstrap set while the network fetch is still pending', async () => {
    const deferred = deferredFetch();
    const client = makeClient({
      fetch: deferred.fetch,
      bootstrap: { flags: { beta_banner: true, checkout_variant: 'a' }, payloads: { checkout_variant: { discount: 10 } } },
    });

    // The network mock is NOT resolved — yet the first evaluate returns the bootstrap set.
    const set = await client.evaluate();

    expect(set.isEnabled('beta_banner')).toBe(true);
    expect(set.getFlag('checkout_variant')).toBe('a');
    expect(set.getPayload('checkout_variant')).toEqual({ discount: 10 });
    expect(set.reason('beta_banner')).toBe('bootstrap');
    expect(set.degraded).toBe(false);
    // A background fetch WAS kicked off (so onChange fires when it lands).
    expect(deferred.calls).toHaveLength(1);
  });

  test('onChange fires with the network set once the fetch later resolves', async () => {
    const deferred = deferredFetch();
    const client = makeClient({
      fetch: deferred.fetch,
      bootstrap: { flags: { beta_banner: true } },
    });
    const seen: Array<FlagSet> = [];
    client.onChange((set) => seen.push(set));

    await client.evaluate(); // returns bootstrap immediately; fetch pending
    expect(seen).toHaveLength(0);

    // The network arrives with a different set.
    deferred.resolveWith(jsonResponse({ featureFlags: { beta_banner: false, new_flag: 'x' }, featureFlagPayloads: {} }));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0].getFlag('beta_banner')).toBe(false);
    expect(seen[0].getFlag('new_flag')).toBe('x');
    expect(seen[0].reason('new_flag')).toBe('resolved');
    expect(seen[0].degraded).toBe(false);
  });
});

describe('evaluate resolves the fetched set (AC: fresh network arrival reads resolved)', () => {
  test('with no bootstrap, the first evaluate awaits the fetch and returns the resolved set', async () => {
    const client = makeClient({
      fetch: async () => jsonResponse({ featureFlags: { dark_mode: true }, featureFlagPayloads: { dark_mode: { tone: 'slate' } } }),
    });

    const set = await client.evaluate();

    expect(set.isEnabled('dark_mode')).toBe(true);
    expect(set.getPayload('dark_mode')).toEqual({ tone: 'slate' });
    expect(set.reason('dark_mode')).toBe('resolved');
    expect(set.getAll()).toEqual({ dark_mode: true });
    expect(set.degraded).toBe(false);
  });

  test('a second evaluate serves the cached resolved set without re-fetching', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ featureFlags: { a: true }, featureFlagPayloads: {} }));
    const client = makeClient({ fetch: fetchSpy });

    await client.evaluate();
    await client.evaluate();

    // The first evaluate fetched; the second read the cache — one network call total.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('onChange cardinality (AC: fires on arrival, re-fires on refresh, unsubscribe stops it)', () => {
  test('re-fires on a forced refresh (evaluate options { refresh: true }) and the unsubscribe halts further calls', async () => {
    let call = 0;
    const client = makeClient({
      fetch: async () => {
        call += 1;
        return jsonResponse({ featureFlags: { v: `arrival-${call}` }, featureFlagPayloads: {} });
      },
    });
    const seen: Array<string | boolean | undefined> = [];
    const unsubscribe = client.onChange((set) => seen.push(set.getFlag('v')));

    await client.evaluate(); // first arrival
    await client.evaluate(undefined, { refresh: true }); // forced re-fetch → re-fire
    expect(seen).toEqual(['arrival-1', 'arrival-2']);

    unsubscribe();
    await client.evaluate(undefined, { refresh: true }); // fetches, but the listener is gone
    expect(seen).toEqual(['arrival-1', 'arrival-2']);
  });

  // REGRESSION (architect-reviewer critical): a forced refresh with a NEW context must issue a
  // wire fetch carrying that new context, NEVER coalesce onto a stale in-flight fetch built from
  // an earlier context. The bootstrap fire-and-forget fetch (evaluate() → void refresh) is the
  // in-flight one here; the forced refresh with a different distinctId must not adopt its body.
  test('a forced refresh with a NEW context, while a prior fetch is in flight, fetches the NEW context (not the stale in-flight one)', async () => {
    const queued = queuedFetch();
    const client = makeClient({
      fetch: queued.fetch,
      bootstrap: { flags: { seeded: true } },
      getDistinctId: () => 'identity-id',
    });

    // First evaluate serves bootstrap immediately and fires a fire-and-forget background fetch
    // (call #0) that stays PENDING — we never resolve it.
    await client.evaluate();
    expect(queued.calls).toHaveLength(1);
    const firstBody = JSON.parse(queued.calls[0].options.body) as Record<string, unknown>;
    expect(firstBody.distinct_id).toBe('identity-id');

    // Now force a refresh for a DIFFERENT actor while call #0 is still in flight.
    const forced = client.evaluate({ distinctId: 'forced-actor' }, { refresh: true });
    // Let the in-flight #0 settle so the chained follow-up runs, then resolve the follow-up.
    queued.resolveCall(0, jsonResponse({ featureFlags: { seeded: false }, featureFlagPayloads: {} }));
    await vi.waitFor(() => expect(queued.calls.length).toBeGreaterThanOrEqual(2));
    queued.resolveCall(1, jsonResponse({ featureFlags: { forced_flag: true }, featureFlagPayloads: {} }));
    const set = await forced;

    // A SECOND wire call was made, and it carried the NEW context's distinct id — the forced
    // refresh did not silently return the stale in-flight request.
    expect(queued.calls.length).toBeGreaterThanOrEqual(2);
    const secondBody = JSON.parse(queued.calls[1].options.body) as Record<string, unknown>;
    expect(secondBody.distinct_id).toBe('forced-actor');
    // And the forced refresh resolved to the follow-up fetch's set, not the stale one.
    expect(set.getFlag('forced_flag')).toBe(true);
  });
});

describe('distinctId sourcing (AC: filled from identity when absent, explicit overrides)', () => {
  test('a missing context.distinctId is filled from the browser identity', async () => {
    const deferred = deferredFetch();
    const client = makeClient({ fetch: deferred.fetch, getDistinctId: () => 'from-identity' });

    void client.evaluate();

    const body = JSON.parse(deferred.calls[0].options.body) as Record<string, unknown>;
    expect(body.distinct_id).toBe('from-identity');
  });

  test('an explicit context.distinctId overrides the browser identity', async () => {
    const deferred = deferredFetch();
    const client = makeClient({ fetch: deferred.fetch, getDistinctId: () => 'from-identity' });

    void client.evaluate({ distinctId: 'explicit-id' });

    const body = JSON.parse(deferred.calls[0].options.body) as Record<string, unknown>;
    expect(body.distinct_id).toBe('explicit-id');
  });
});

describe('degradation signal (AC: failed fetch sets degraded + a neutral reason)', () => {
  test("a failed refresh serving a prior set reads 'stale' + degraded, keeping the prior values", async () => {
    let ok = true;
    const client = makeClient({
      fetch: async () => (ok ? jsonResponse({ featureFlags: { gate: true }, featureFlagPayloads: {} }) : jsonResponse({}, 500)),
    });

    const first = await client.evaluate();
    expect(first.reason('gate')).toBe('resolved');

    ok = false;
    const stale = await client.evaluate(undefined, { refresh: true });

    // The prior value is still served — a real "off" is distinguishable from a failed round-trip.
    expect(stale.getFlag('gate')).toBe(true);
    expect(stale.reason('gate')).toBe('stale');
    expect(stale.degraded).toBe(true);
  });

  test("a failed fetch with NO bootstrap/stale fallback returns the seam's 'unresolved' empty snapshot", async () => {
    const client = makeClient({ fetch: async () => jsonResponse({}, 503) });

    const set = await client.evaluate();

    expect(set.getAll()).toEqual({});
    expect(set.isEnabled('anything')).toBe(false);
    expect(set.getFlag('anything')).toBeUndefined();
    expect(set.degraded).toBe(true);
    expect(set.reason('anything')).toBe('unresolved');
  });

  test('a network rejection (thrown) degrades exactly like a non-2xx status', async () => {
    const deferred = deferredFetch();
    const client = makeClient({ fetch: deferred.fetch });
    const pending = client.evaluate();
    deferred.rejectWith(new Error('network down'));

    const set = await pending;
    expect(set.degraded).toBe(true);
    expect(set.reason('anything')).toBe('unresolved');
  });

  test('an absent ingest host never fetches; evaluate serves the empty unresolved snapshot', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ featureFlags: { a: true }, featureFlagPayloads: {} }));
    const client = makeClient({ fetch: fetchSpy, ingestHost: undefined });

    const set = await client.evaluate();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(set.reason('a')).toBe('unresolved');
    expect(set.degraded).toBe(true);
  });
});

describe('wire boundary (AC: neutral context maps to the [WIRE] body; no leak onto the snapshot)', () => {
  test('the flag-eval request targets the flag path on the configured host and carries the auth token', async () => {
    const deferred = deferredFetch();
    const client = makeClient({ fetch: deferred.fetch });

    void client.evaluate();

    expect(deferred.calls[0].url).toBe('https://analytics.example.com/flags/');
    const body = JSON.parse(deferred.calls[0].options.body) as Record<string, unknown>;
    expect(body.token).toBe('proj-key');
  });

  test('FlagContext fields map onto the wire body only when supplied', async () => {
    const deferred = deferredFetch();
    const client = makeClient({ fetch: deferred.fetch });

    void client.evaluate({
      distinctId: 'u1',
      groups: { org: 'acme' },
      personProperties: { plan: 'pro' },
      groupProperties: { org: { tier: 'gold' } },
      flagKeys: ['a', 'b'],
    });

    const body = JSON.parse(deferred.calls[0].options.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      distinct_id: 'u1',
      groups: { org: 'acme' },
      person_properties: { plan: 'pro' },
      group_properties: { org: { tier: 'gold' } },
      flag_keys: ['a', 'b'],
    });
  });

  test('an empty FlagContext sends only the token + identity-filled distinct_id, no undefined keys', async () => {
    const deferred = deferredFetch();
    const client = makeClient({ fetch: deferred.fetch, getDistinctId: () => 'id1' });

    void client.evaluate();

    const body = JSON.parse(deferred.calls[0].options.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['distinct_id', 'token']);
  });
});

// Taxonomy narrowing is a compile-time concern: a typed taxonomy declaring `flags` must narrow
// the FlagSet reads a consumer gets off a typed FlagClient. Mirrors the S1 ports type-test.
describe('taxonomy-typed reads (AC: getPayload/getFlag narrow per declared variants/payload)', () => {
  test('getFlag narrows to the declared variant union and getPayload to the declared payload shape', () => {
    const taxonomy = defineTaxonomy({
      events: {},
      flags: {
        checkout_variant: { variants: ['a', 'b'], payload: { discount: 'number' } },
        dark_mode: {},
      },
    });
    type TX = ShapeOf<typeof taxonomy.decl>;
    // The taxonomy value is what a real consumer holds; assert it round-tripped so it's a live
    // runtime binding (not a type-only ghost) while its shape drives the narrowing below.
    expect(taxonomy.decl.flags.checkout_variant.variants).toEqual(['a', 'b']);
    const client = new FlagClient<TX>({
      key: 'k',
      ingestHost: HOST,
      getDistinctId: () => 'id',
      fetch: async () => jsonResponse({ featureFlags: {}, featureFlagPayloads: {} }),
    });

    expectTypeOf(client.evaluate).returns.resolves.toEqualTypeOf<FlagSet<TX>>();

    // A real, callable snapshot (the seam null-object) typed to TX — its reads narrow per the
    // declared taxonomy without needing a live fetch.
    const set = emptyFlagSet<TX>();
    expectTypeOf(set.getFlag('checkout_variant')).toEqualTypeOf<'a' | 'b' | boolean | undefined>();
    expectTypeOf(set.getPayload('checkout_variant')).toEqualTypeOf<{ discount: number } | undefined>();
    expectTypeOf(set.getFlag('dark_mode')).toEqualTypeOf<boolean | undefined>();
    expectTypeOf(set.getPayload('dark_mode')).toEqualTypeOf<unknown>();
  });
});
