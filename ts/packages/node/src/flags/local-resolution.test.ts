import type { DefaultTaxonomyShape } from 'analytics-kit';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { HttpFlagAdapter, type LocalEvalCapability } from './http-flag-adapter';
import { DefinitionPoller } from './local';
import type { FlagDefinition } from './local';

// A definition that resolves locally to `true` for everyone (100% rollout, no property filters) and
// carries a payload keyed by 'true'.
const LOCAL_TRUE: FlagDefinition = {
  key: 'local_on',
  active: true,
  filters: {
    groups: [{ properties: [], rollout_percentage: 100 }],
    payloads: { true: { via: 'local' } },
  },
};

// A definition whose experience-continuity flag makes the local matcher throw InconclusiveMatchError
// — the classic "have the definition, can't decide locally" case that drives the remote fallback.
const INCONCLUSIVE: FlagDefinition = {
  key: 'needs_remote',
  active: true,
  ensure_experience_continuity: true,
  filters: { groups: [{ properties: [], rollout_percentage: 100 }] },
};

// A definition referencing a cohort NOT present in the local cohort map — a static cohort that throws
// RequiresServerEvaluation (the second, distinct inconclusive signal).
const STATIC_COHORT: FlagDefinition = {
  key: 'static_cohort',
  active: true,
  filters: {
    groups: [
      { properties: [{ key: 'id', type: 'cohort', value: 999, operator: 'in' }], rollout_percentage: 100 },
    ],
  },
};

function defsResponse(flags: FlagDefinition[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ flags, group_type_mapping: {}, cohorts: {} }),
  };
}

function flagsResponse(body: { featureFlags?: Record<string, string | boolean>; featureFlagPayloads?: Record<string, unknown> }) {
  return { ok: true, status: 200, json: async () => body };
}

// A single injected fetch routed by method: GET ⇒ the poller's definitions load, POST ⇒ the remote
// flag round-trip. Records every POST body so a test can assert whether — and for which keys — the
// remote path was reached.
function makeRoutedFetch(opts: {
  definitions: FlagDefinition[];
  remote?: { featureFlags?: Record<string, string | boolean>; featureFlagPayloads?: Record<string, unknown> };
  remoteOk?: boolean;
}) {
  const posts: Array<{ distinct_id: string; flag_keys_to_evaluate?: string[] }> = [];
  const fetchSpy = vi.fn(async (_url: string, init: { method: string; body?: string }) => {
    if (init.method === 'GET') {
      return defsResponse(opts.definitions);
    }
    posts.push(JSON.parse(init.body as string));
    if (opts.remoteOk === false) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return flagsResponse(opts.remote ?? { featureFlags: {}, featureFlagPayloads: {} });
  });
  return { fetchSpy, posts };
}

function makePoller(fetchImpl: unknown): DefinitionPoller {
  return new DefinitionPoller({
    definitionsEndpoint: 'https://flags.example',
    definitionsKey: 'k_privileged',
    token: 'k_project',
    pollIntervalMs: 30000,
    fetch: fetchImpl as never,
  });
}

// Build a local-capable adapter over the routed fetch, await the poller's first load (so isReady() is
// true before the evaluate under test), and hand back the pieces.
async function makeLocalAdapter(opts: {
  definitions: FlagDefinition[];
  remote?: { featureFlags?: Record<string, string | boolean>; featureFlagPayloads?: Record<string, unknown> };
  remoteOk?: boolean;
  onlyLocally?: boolean;
  flagEndpoint?: string | undefined;
  bootstrap?: { flags?: Record<string, string | boolean>; payloads?: Record<string, unknown> };
}): Promise<{
  adapter: HttpFlagAdapter<DefaultTaxonomyShape>;
  posts: Array<{ distinct_id: string; flag_keys_to_evaluate?: string[] }>;
  poller: DefinitionPoller;
}> {
  const { fetchSpy, posts } = makeRoutedFetch(opts);
  const poller = makePoller(fetchSpy);
  const local: LocalEvalCapability = { poller, onlyLocally: opts.onlyLocally ?? false };
  const adapter = new HttpFlagAdapter<DefaultTaxonomyShape>({
    key: 'k_project',
    flagEndpoint: 'flagEndpoint' in opts ? opts.flagEndpoint : 'https://flags.example',
    bootstrap: opts.bootstrap,
    fetch: fetchSpy as never,
    local,
  });
  // Drain the constructor's fire-and-forget first load so isReady() is true.
  await poller.start();
  return { adapter, posts, poller };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('local-first resolves a decidable flag with no remote round-trip', () => {
  test('a 100%-rollout flag resolves locally; the remote POST is never called for it', async () => {
    const { adapter, posts, poller } = await makeLocalAdapter({ definitions: [LOCAL_TRUE] });

    const set = await adapter.evaluate({ distinctId: 'u_1' });

    expect(set.isEnabled('local_on')).toBe(true);
    expect(set.getFlag('local_on')).toBe(true);
    // Local payload came off the definition's payload map, not a remote response.
    expect(set.getPayload('local_on')).toEqual({ via: 'local' });
    expect(set.degraded).toBe(false);
    expect(set.reason('local_on')).toBe('resolved');
    // No POST fired — the remote path was NOT reached.
    expect(posts).toHaveLength(0);
    adapter.stop();
    poller.stop();
  });
});

describe('an inconclusive flag falls back to the SHIPPED remote path', () => {
  test('InconclusiveMatchError ⇒ one narrowed round-trip; the merged FlagSet carries both flags', async () => {
    const { adapter, posts, poller } = await makeLocalAdapter({
      definitions: [LOCAL_TRUE, INCONCLUSIVE],
      remote: { featureFlags: { needs_remote: 'variant_x' }, featureFlagPayloads: { needs_remote: { via: 'remote' } } },
    });

    const set = await adapter.evaluate({ distinctId: 'u_1' });

    // Locally-resolved flag kept.
    expect(set.getFlag('local_on')).toBe(true);
    // Remotely-resolved flag layered in.
    expect(set.getFlag('needs_remote')).toBe('variant_x');
    expect(set.getPayload('needs_remote')).toEqual({ via: 'remote' });
    expect(set.degraded).toBe(false);
    // Exactly one round-trip, narrowed to just the unresolved key.
    expect(posts).toHaveLength(1);
    expect(posts[0].flag_keys_to_evaluate).toEqual(['needs_remote']);
    adapter.stop();
    poller.stop();
  });

  test('RequiresServerEvaluation (static cohort) ALSO drives the same fallback', async () => {
    const { adapter, posts, poller } = await makeLocalAdapter({
      definitions: [STATIC_COHORT],
      remote: { featureFlags: { static_cohort: true }, featureFlagPayloads: {} },
    });

    const set = await adapter.evaluate({ distinctId: 'u_1' });

    expect(set.getFlag('static_cohort')).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0].flag_keys_to_evaluate).toEqual(['static_cohort']);
    adapter.stop();
    poller.stop();
  });
});

describe('onlyEvaluateLocally suppresses the fallback', () => {
  test('an inconclusive flag resolves to its degraded neutral state, no round-trip fires', async () => {
    const { adapter, posts, poller } = await makeLocalAdapter({
      definitions: [LOCAL_TRUE, INCONCLUSIVE],
      onlyLocally: true,
    });

    const set = await adapter.evaluate({ distinctId: 'u_1' });

    // The locally-decidable flag still resolves.
    expect(set.getFlag('local_on')).toBe(true);
    // The inconclusive flag is dropped — its read collapses to the neutral unresolved state.
    expect(set.getFlag('needs_remote')).toBeUndefined();
    expect(set.isEnabled('needs_remote')).toBe(false);
    expect(set.reason('needs_remote')).toBeUndefined();
    // The snapshot degrades because a requested flag could not be resolved.
    expect(set.degraded).toBe(true);
    // No POST — the remote path was suppressed.
    expect(posts).toHaveLength(0);
    adapter.stop();
    poller.stop();
  });

  test('local-only with every flag decidable resolves clean (no degrade, no round-trip)', async () => {
    const { adapter, posts, poller } = await makeLocalAdapter({
      definitions: [LOCAL_TRUE],
      onlyLocally: true,
    });

    const set = await adapter.evaluate({ distinctId: 'u_1' });

    expect(set.getFlag('local_on')).toBe(true);
    expect(set.degraded).toBe(false);
    expect(set.reason('local_on')).toBe('resolved');
    expect(posts).toHaveLength(0);
    adapter.stop();
    poller.stop();
  });

  test('local-only with the poller not ready resolves to degraded-empty, no round-trip', async () => {
    const { fetchSpy, posts } = makeRoutedFetch({ definitions: [LOCAL_TRUE] });
    const poller = makePoller(fetchSpy);
    const adapter = new HttpFlagAdapter<DefaultTaxonomyShape>({
      key: 'k_project',
      flagEndpoint: undefined,
      fetch: fetchSpy as never,
      local: { poller, onlyLocally: true },
    });
    // Do NOT await the load — the poller is not ready.
    const set = await adapter.evaluate({ distinctId: 'u_1' });

    expect(set.getAll()).toEqual({});
    expect(set.degraded).toBe(true);
    expect(set.reason('anything')).toBeUndefined();
    expect(posts).toHaveLength(0);
    adapter.stop();
    poller.stop();
  });
});

describe('local and remote are indistinguishable to the consumer', () => {
  test('a locally-resolved flag reads identically to a remotely-resolved one', async () => {
    // Local adapter resolving `k` = true locally.
    const localDef: FlagDefinition = {
      key: 'k',
      active: true,
      filters: { groups: [{ properties: [], rollout_percentage: 100 }], payloads: { true: { p: 1 } } },
    };
    const { adapter: localAdapter, poller } = await makeLocalAdapter({ definitions: [localDef] });
    const localSet = await localAdapter.evaluate({ distinctId: 'u_1' });

    // A remote-only adapter resolving the same `k` = true + same payload.
    const remoteFetch = vi.fn(async () => flagsResponse({ featureFlags: { k: true }, featureFlagPayloads: { k: { p: 1 } } }));
    const remoteAdapter = new HttpFlagAdapter<DefaultTaxonomyShape>({
      key: 'k_project',
      flagEndpoint: 'https://flags.example',
      fetch: remoteFetch as never,
    });
    const remoteSet = await remoteAdapter.evaluate({ distinctId: 'u_1' });

    // Same surface behavior across strategies.
    expect(localSet.isEnabled('k')).toBe(remoteSet.isEnabled('k'));
    expect(localSet.getFlag('k')).toBe(remoteSet.getFlag('k'));
    expect(localSet.getPayload('k')).toEqual(remoteSet.getPayload('k'));
    expect(localSet.degraded).toBe(remoteSet.degraded);
    expect(localSet.reason('k')).toBe(remoteSet.reason('k'));
    localAdapter.stop();
    poller.stop();
  });

  test('a local fallback-that-failed reads identically to a remote failure (degraded, unresolved)', async () => {
    // Local adapter whose only flag is inconclusive and whose fallback round-trip FAILS.
    const { adapter: localAdapter, posts, poller } = await makeLocalAdapter({
      definitions: [INCONCLUSIVE],
      remoteOk: false,
    });
    const localSet = await localAdapter.evaluate({ distinctId: 'u_1' });

    // A pure remote adapter whose round-trip also FAILS.
    const remoteFetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const remoteAdapter = new HttpFlagAdapter<DefaultTaxonomyShape>({
      key: 'k_project',
      flagEndpoint: 'https://flags.example',
      fetch: remoteFetch as never,
    });
    const remoteSet = await remoteAdapter.evaluate({ distinctId: 'u_1' });

    // The fallback was attempted (POST fired) then failed.
    expect(posts).toHaveLength(1);
    expect(localSet.degraded).toBe(true);
    expect(localSet.degraded).toBe(remoteSet.degraded);
    expect(localSet.getFlag('needs_remote')).toBe(remoteSet.getFlag('needs_remote'));
    expect(localSet.reason('needs_remote')).toBe(remoteSet.reason('needs_remote'));
    localAdapter.stop();
    poller.stop();
  });
});

describe('remote-only fallthrough when the poller is not ready (fallback allowed)', () => {
  test('an evaluate before definitions load goes to the plain remote path with the FULL context', async () => {
    const { fetchSpy, posts } = makeRoutedFetch({
      definitions: [LOCAL_TRUE],
      remote: { featureFlags: { local_on: true }, featureFlagPayloads: {} },
    });
    const poller = makePoller(fetchSpy);
    const adapter = new HttpFlagAdapter<DefaultTaxonomyShape>({
      key: 'k_project',
      flagEndpoint: 'https://flags.example',
      fetch: fetchSpy as never,
      local: { poller, onlyLocally: false },
    });
    // Evaluate WITHOUT awaiting the load — poller not ready ⇒ pure remote path.
    const set = await adapter.evaluate({ distinctId: 'u_1', flagKeys: ['local_on', 'other'] });

    expect(set.getFlag('local_on')).toBe(true);
    expect(posts).toHaveLength(1);
    // The remote body carries the ORIGINAL flagKeys untouched (nothing narrowed to a fallback set).
    expect(posts[0].flag_keys_to_evaluate).toEqual(['local_on', 'other']);
    adapter.stop();
    poller.stop();
  });
});

describe('flagKeys narrowing on the local pass', () => {
  test('only the requested keys are evaluated locally; an unknown requested key drops out silently', async () => {
    const other: FlagDefinition = {
      key: 'other_on',
      active: true,
      filters: { groups: [{ properties: [], rollout_percentage: 100 }] },
    };
    const { adapter, posts, poller } = await makeLocalAdapter({ definitions: [LOCAL_TRUE, other] });

    const set = await adapter.evaluate({ distinctId: 'u_1', flagKeys: ['local_on', 'ghost'] });

    // Only the requested + defined key resolves; the other definition is not evaluated.
    expect(set.getFlag('local_on')).toBe(true);
    expect(set.getFlag('other_on')).toBeUndefined();
    // The unknown requested key ('ghost') has no definition, so it never becomes a fallback key.
    expect(posts).toHaveLength(0);
    expect(set.degraded).toBe(false);
    adapter.stop();
    poller.stop();
  });
});

describe('distinctId-required + onChange contracts are unchanged under local eval', () => {
  test('distinctId-required still throws pre-eval on a local-capable adapter (no fetch)', async () => {
    const { fetchSpy } = makeRoutedFetch({ definitions: [LOCAL_TRUE] });
    const poller = makePoller(fetchSpy);
    const adapter = new HttpFlagAdapter<DefaultTaxonomyShape>({
      key: 'k_project',
      flagEndpoint: 'https://flags.example',
      fetch: fetchSpy as never,
      local: { poller, onlyLocally: false },
    });

    await expect(adapter.evaluate({})).rejects.toThrow(/distinctId is required/);
    await expect(adapter.evaluate({ distinctId: '' })).rejects.toThrow(/distinctId is required/);
    adapter.stop();
    poller.stop();
  });

  test('onChange fires exactly once even when the resolution used the local branch', async () => {
    const { adapter, poller } = await makeLocalAdapter({ definitions: [LOCAL_TRUE] });
    const seen: number[] = [];
    adapter.onChange(() => seen.push(1));

    await adapter.evaluate({ distinctId: 'u_1' });
    await adapter.evaluate({ distinctId: 'u_2' });
    await adapter.evaluate({ distinctId: 'u_3' });

    expect(seen).toHaveLength(1);
    adapter.stop();
    poller.stop();
  });
});
