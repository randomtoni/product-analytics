import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createAnalytics as createBrowserAnalytics } from '@randomtoni/analytics-kit-browser';
import { createFlagClient } from '@randomtoni/analytics-kit-node';
import type { FeatureFlagPort, FlagSet } from '@randomtoni/analytics-kit';
import { fernlyTaxonomy } from './taxonomy';
import {
  FERNLY_FLAG_BOOTSTRAP,
  createFakeFlagPort,
  createFernlyFlagClient,
  type FernlyFlagShape,
} from './flag-harness';

// The taxonomy-typed flag client — createFlagClient<T>({ taxonomy }) returns a
// FeatureFlagPort<ShapeOf<T>>, the path where getFlag/getPayload narrow against the flags slot.
// (The browser provider.flags slot is the untyped port by design; narrowing rides this factory /
// the React hook.) A stub fetch keeps it off the network.
function typedFernlyFlagClient(): FeatureFlagPort<FernlyFlagShape> {
  return createFlagClient({
    key: 'fernly-flag-key',
    flagEndpoint: 'https://flags.fernly.example',
    taxonomy: fernlyTaxonomy,
    fetch: (async () => ({
      ok: true,
      status: 200,
      text: async () => '{}',
      json: async () => ({ featureFlags: { review_ai_summary: 'detailed', bulk_review_actions: false } }),
    })) as never,
  });
}

// E12-S6 — Fernly (TS) flag exercise. Proves the shipped feature-flag surface (S1–S5) works
// through the neutral port BY CONFIG ALONE: config-supplied bootstrap (bar B), evaluate + typed
// reads + onChange, a bar-A swap to a mock FeatureFlagPort with ZERO consumer change (browser
// via provider.flags AND node via createFlagClient), and the unkeyed/endpointless no-flags paths.
//
// The behavior proof rides the REAL browser FlagClient (via @randomtoni/analytics-kit-browser createAnalytics
// with a stubbed global fetch), not a hand-rolled fake — the fake exists only for the bar-A
// swap-equivalence proof. Assertions land on the neutral FlagSet reads, never adapter wire keys.

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe('Fernly flags — config-supplied bootstrap seeds a sync read before the fetch resolves (bar B)', () => {
  it('the first evaluate() serves the bootstrap set (reason "bootstrap") while the fetch is pending', async () => {
    const handle = createFernlyFlagClient(originalFetch, (stub) => vi.stubGlobal('fetch', stub));
    const flags = handle.analytics.flags;
    expect(flags).toBeDefined();

    // evaluate() serves the bootstrap-seeded cache immediately and only kicks a background fetch;
    // it does NOT await the network, so the awaited snapshot reads 'bootstrap' before the fetch
    // commits 'resolved'. The flash-of-wrong-variant kill.
    const seeded = await flags!.evaluate();
    expect(seeded.reason('review_ai_summary')).toBe('bootstrap');
    expect(seeded.degraded).toBe(false);
    expect(seeded.getFlag('review_ai_summary')).toBe('concise');
    expect(seeded.getPayload('review_ai_summary')).toEqual({ model: 'draft-1', maxTokens: 256 });
    expect(seeded.isEnabled('bulk_review_actions')).toBe(true);
  });

  it('onChange re-fires with the network set (reason "resolved") once the fetch arrives', async () => {
    const handle = createFernlyFlagClient(originalFetch, (stub) => vi.stubGlobal('fetch', stub));
    const flags = handle.analytics.flags!;

    const arrivals: FlagSet[] = [];
    flags.onChange((next) => arrivals.push(next));

    await flags.evaluate(); // serves bootstrap, starts the background fetch
    handle.resolveFetch(); // let the network set commit
    await vi.waitFor(() => expect(arrivals.length).toBeGreaterThan(0));

    const arrived = arrivals[arrivals.length - 1]!;
    expect(arrived.reason('review_ai_summary')).toBe('resolved');
    expect(arrived.getFlag('review_ai_summary')).toBe('detailed');
    expect(arrived.getPayload('review_ai_summary')).toEqual({ model: 'review-9', maxTokens: 1024 });
    expect(arrived.isEnabled('bulk_review_actions')).toBe(false);
  });

  it('a forced evaluate({ refresh: true }) awaits a fresh fetch and resolves the network set', async () => {
    const handle = createFernlyFlagClient(originalFetch, (stub) => vi.stubGlobal('fetch', stub));
    const flags = handle.analytics.flags!;

    handle.resolveFetch(); // fetch resolves immediately for the forced path
    const refreshed = await flags.evaluate({ distinctId: 'reviewer-1' }, { refresh: true });
    expect(refreshed.reason('review_ai_summary')).toBe('resolved');
    expect(refreshed.getFlag('review_ai_summary')).toBe('detailed');
    expect(handle.fetchCount()).toBeGreaterThan(0);
  });
});

describe('Fernly flags — taxonomy-typed reads narrow against the flags slot', () => {
  it('getFlag narrows to the declared variant union | boolean; getPayload to the payload shape', async () => {
    // The taxonomy-typed path: createFlagClient<T>({ taxonomy }) → FeatureFlagPort<ShapeOf<T>>,
    // whose FlagSet reads narrow against the declared flags slot.
    const set = await typedFernlyFlagClient().evaluate({ distinctId: 'reviewer-1' });

    // A variant flag narrows getFlag to its declared variant union | boolean.
    expectTypeOf(set.getFlag('review_ai_summary')).toEqualTypeOf<
      'control' | 'concise' | 'detailed' | boolean | undefined
    >();
    // A bare (variant-less) flag narrows getFlag to boolean.
    expectTypeOf(set.getFlag('bulk_review_actions')).toEqualTypeOf<boolean | undefined>();
    // getPayload narrows to the declared flat payload shape.
    expectTypeOf(set.getPayload('review_ai_summary')).toEqualTypeOf<
      { model: string; maxTokens: number } | undefined
    >();
  });
});

describe('Fernly flags — bar B negative: an unkeyed config gets no flags (gracefully)', () => {
  it('an unkeyed browser client leaves provider.flags undefined (NoopAdapter path, no flag machinery)', () => {
    // Byte-identical adoption shape minus the key: the flag slot stays undefined, so an
    // unconfigured environment reads flags-off with zero crash — the config-only bar-B posture.
    const unkeyed = createBrowserAnalytics({ taxonomy: fernlyTaxonomy, flags: { bootstrap: FERNLY_FLAG_BOOTSTRAP } });
    expect(unkeyed.flags).toBeUndefined();
  });
});

describe('Fernly flags — bar A: swap to a mock FeatureFlagPort, ZERO consumer change (browser slot)', () => {
  // The byte-identical consumer read function — run against the real browser FlagClient AND the
  // mock port with no edit. This is the bar-A hard proof for flags: the same neutral reads resolve
  // regardless of which FeatureFlagPort backs the slot. Typed as the untyped seam port, matching
  // the shipped provider.flags slot (the swap surface a browser consumer actually touches).
  const readFlags = (flags: FeatureFlagPort): Promise<{ variant: string | boolean | undefined; on: boolean }> =>
    flags.evaluate().then((set) => ({
      variant: set.getFlag('review_ai_summary'),
      on: set.isEnabled('bulk_review_actions'),
    }));

  it('the same reads resolve against the real FlagClient and against the mock port', async () => {
    const handle = createFernlyFlagClient(originalFetch, (stub) => vi.stubGlobal('fetch', stub));
    const realReads = await readFlags(handle.analytics.flags!);
    expect(realReads.variant).toBe('concise'); // the bootstrap set (fetch still pending)
    expect(realReads.on).toBe(true);

    const mock = createFakeFlagPort(
      { review_ai_summary: 'detailed', bulk_review_actions: false },
      { review_ai_summary: { model: 'mock', maxTokens: 1 } }
    );
    const mockReads = await readFlags(mock);
    expect(mockReads.variant).toBe('detailed');
    expect(mockReads.on).toBe(false);

    // Consumer code was byte-identical (readFlags) across the swap — only the backing port changed.
  });
});

describe('Fernly flags — bar A: node createFlagClient swap (standalone factory, no provider slot)', () => {
  const NODE_WIRE = {
    featureFlags: { review_ai_summary: 'detailed', bulk_review_actions: false },
    featureFlagPayloads: { review_ai_summary: { model: 'srv', maxTokens: 2048 } },
  };

  function nodeFetchStub(): () => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }> {
    return async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(NODE_WIRE),
      json: async () => NODE_WIRE,
    });
  }

  const readServerFlags = (flags: FeatureFlagPort<FernlyFlagShape>): Promise<string | boolean | undefined> =>
    flags.evaluate({ distinctId: 'reviewer-1' }).then((set) => set.getFlag('review_ai_summary'));

  it('the same server reads resolve against the real HttpFlagAdapter and against the mock port', async () => {
    // Keyed + endpointed ⇒ the real HttpFlagAdapter (the injected fetch stub is consulted). The
    // taxonomy overload types the client FeatureFlagPort<FernlyFlagShape>.
    const real = createFlagClient({
      key: 'fernly-flag-key',
      flagEndpoint: 'https://flags.fernly.example',
      taxonomy: fernlyTaxonomy,
      fetch: nodeFetchStub() as never,
    });
    expect(await readServerFlags(real)).toBe('detailed');

    const mock = createFakeFlagPort<FernlyFlagShape>({ review_ai_summary: 'concise' });
    expect(await readServerFlags(mock)).toBe('concise');
    // Byte-identical readServerFlags across the swap.
  });

  it('the server path requires distinctId — evaluate({}) throws pre-network, the fetch is never called', async () => {
    let hits = 0;
    const countingFetch = async () => {
      hits += 1;
      return { status: 200, text: async () => '{}', json: async () => ({}) };
    };
    const real = createFlagClient({
      key: 'fernly-flag-key',
      flagEndpoint: 'https://flags.fernly.example',
      fetch: countingFetch as never,
    });

    await expect(real.evaluate({})).rejects.toThrow(/distinctId is required/i);
    expect(hits).toBe(0); // no wire body built for a missing actor
  });

  it('bar B: a keyed-but-endpointless config is the flag footgun no-op (empty snapshot, no fetch)', async () => {
    let hits = 0;
    const countingFetch = async () => {
      hits += 1;
      return { status: 200, text: async () => '{}', json: async () => ({}) };
    };
    // Keyed but no flagEndpoint ⇒ the silent FlagNoop; evaluate resolves the 'unresolved' empty
    // snapshot and never touches the fetch — the analog of the query endpointless footgun.
    const noop = createFlagClient({ key: 'fernly-flag-key', fetch: countingFetch as never });
    const set = await noop.evaluate({ distinctId: 'reviewer-1' });
    expect(set.degraded).toBe(true);
    expect(set.reason('review_ai_summary')).toBe('unresolved');
    expect(set.getAll()).toEqual({});
    expect(hits).toBe(0);
  });
});
