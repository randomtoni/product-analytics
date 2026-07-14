import type { DefaultTaxonomyShape } from '@randomtoni/analytics-kit';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createFlagClient } from './create-flag-client';
import type { FeatureFlagDefinition } from './local/neutral-definition';
import { FlagNoop } from './flag-noop';
import { HttpFlagAdapter, type LocalEvalCapability } from './http-flag-adapter';
import { DefinitionPoller } from './local';
import type { FlagDefinition } from './local';

// E20-S2 — static-definitions config seeding (TS node).
//
// A consumer supplies STATIC flag definitions (the neutral S1 shape) via config; the local-eval
// snapshot is SEEDED directly (bypassing the poller fetch). This suite proves the zero-egress
// invariant (no `/flags/` calls, no definition fetch, no URL) against a recording/injectable
// transport, the equal-value-vs-poller invariant (a static-seeded client resolves to the SAME values
// the poller path resolves for equivalent WIRE definitions), and that a malformed static set raises
// LOUDLY at client construction. Mirrors the `local-parity.test.ts` posture.

// ---------------------------------------------------------------------------------------------
// The neutral static definitions the consumer authors (S1 `FeatureFlagDefinition`). Their WIRE
// equivalents drive the poller path in the equal-value proof below.
// ---------------------------------------------------------------------------------------------

// A 100%-rollout boolean flag → `true` for every actor; payload keyed by the resolved value.
const SIMPLE_STATIC: FeatureFlagDefinition = {
  key: 'simple-flag',
  enabled: true,
  conditions: [{ propertyFilters: [], rolloutPercentage: 100 }],
  payloads: { true: JSON.stringify({ via: 'defn' }) },
};

// The pinned multivariate flag (group 55%, variants 50/20/20/5/5) → `distinct_id_0` → second-variant.
const MULTIVARIATE_STATIC: FeatureFlagDefinition = {
  key: 'multivariate-flag',
  enabled: true,
  conditions: [{ propertyFilters: [], rolloutPercentage: 55 }],
  variants: [
    { key: 'first-variant', rolloutPercentage: 50 },
    { key: 'second-variant', rolloutPercentage: 20 },
    { key: 'third-variant', rolloutPercentage: 20 },
    { key: 'fourth-variant', rolloutPercentage: 5 },
    { key: 'fifth-variant', rolloutPercentage: 5 },
  ],
  payloads: { 'second-variant': JSON.stringify({ tier: 'silver' }) },
};

// A property-gated flag (plan=pro at 100%) → `true` when the person property is supplied.
const PROP_STATIC: FeatureFlagDefinition = {
  key: 'prop-flag',
  enabled: true,
  conditions: [{ propertyFilters: [{ property: 'plan', value: 'pro' }], rolloutPercentage: 100 }],
};

const STATIC_DEFINITIONS = [SIMPLE_STATIC, MULTIVARIATE_STATIC, PROP_STATIC];

// The WIRE equivalents of the same definitions — what a poller would fetch and seed. Kept in lockstep
// with the neutral set above; the equal-value proof runs BOTH and asserts identical resolution.
const SIMPLE_WIRE: FlagDefinition = {
  key: 'simple-flag',
  active: true,
  filters: {
    groups: [{ properties: [], rollout_percentage: 100 }],
    payloads: { true: JSON.stringify({ via: 'defn' }) },
  },
};
const MULTIVARIATE_WIRE: FlagDefinition = {
  key: 'multivariate-flag',
  active: true,
  filters: {
    groups: [{ properties: [], rollout_percentage: 55 }],
    multivariate: {
      variants: [
        { key: 'first-variant', rollout_percentage: 50 },
        { key: 'second-variant', rollout_percentage: 20 },
        { key: 'third-variant', rollout_percentage: 20 },
        { key: 'fourth-variant', rollout_percentage: 5 },
        { key: 'fifth-variant', rollout_percentage: 5 },
      ],
    },
    payloads: { 'second-variant': JSON.stringify({ tier: 'silver' }) },
  },
};
const PROP_WIRE: FlagDefinition = {
  key: 'prop-flag',
  active: true,
  filters: { groups: [{ properties: [{ key: 'plan', value: 'pro' }], rollout_percentage: 100 }] },
};
const WIRE_DEFINITIONS = [SIMPLE_WIRE, MULTIVARIATE_WIRE, PROP_WIRE];

const CONTEXT = { distinctId: 'distinct_id_0', personProperties: { plan: 'pro' } };

// ---------------------------------------------------------------------------------------------
// Zero-egress: a static-defs + local-only client makes NO network calls of any kind.
// ---------------------------------------------------------------------------------------------

describe('zero egress — a static-defs local-only client never touches the transport', () => {
  test('the injected fetch is NEVER called (no /flags/ POST, no definitions GET, no URL)', async () => {
    // The recording transport: any call at all is a failure. A static-seeded client must resolve
    // entirely in-process — no definition fetch, no remote /flags round-trip.
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as never);

    const client = createFlagClient({
      key: 'k',
      staticDefinitions: STATIC_DEFINITIONS,
      onlyEvaluateLocally: true,
      fetch: fetchSpy as never,
    });

    const set = await client.evaluate(CONTEXT);

    // Resolved from the seeded snapshot…
    expect(set.getFlag('simple-flag')).toBe(true);
    expect(set.getFlag('multivariate-flag')).toBe('second-variant');
    expect(set.getFlag('prop-flag')).toBe(true);
    expect(set.degraded).toBe(false);
    // …and the transport was never hit: zero definition fetches, zero /flags/ calls.
    expect(fetchSpy).not.toHaveBeenCalled();

    client.stop();
  });

  test('the canonical self-host shape (key + staticDefinitions + onlyEvaluateLocally) selects the real adapter, no warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as never);

    // NO definitionsEndpoint / definitionsKey / flagEndpoint — the documented zero-`/flags/` shape.
    const client = createFlagClient({
      key: 'k',
      staticDefinitions: STATIC_DEFINITIONS,
      onlyEvaluateLocally: true,
      fetch: fetchSpy as never,
    });

    // A static-defs config is a real route, so the keyed-but-no-route guard does NOT no-op it.
    expect(client).toBeInstanceOf(HttpFlagAdapter);
    expect(client).not.toBeInstanceOf(FlagNoop);
    expect(warn).not.toHaveBeenCalled();

    (client as HttpFlagAdapter<DefaultTaxonomyShape>).stop();
  });

  test('stop() on a static-defs client is a clean idempotent no-op (no thread, no timer)', async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as never);
      const client = createFlagClient({
        key: 'k',
        staticDefinitions: STATIC_DEFINITIONS,
        onlyEvaluateLocally: true,
        pollInterval: 5000,
        fetch: fetchSpy as never,
      });

      // No poll is ever scheduled — advancing well past any interval schedules nothing.
      await vi.advanceTimersByTimeAsync(50_000);
      expect(fetchSpy).not.toHaveBeenCalled();

      expect(() => client.stop()).not.toThrow();
      expect(() => client.stop()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Equal value vs the poller path: a static-seeded client resolves to the SAME values a poller-fed
// client resolves for the equivalent wire definitions — the UNCHANGED evaluator reads the seed
// snapshot identically. The poller side crosses a real socket (mirroring local-parity.test.ts).
// ---------------------------------------------------------------------------------------------

interface Loopback {
  origin: string;
  posts: unknown[];
  close: () => Promise<void>;
}

async function startLoopback(definitions: FlagDefinition[]): Promise<Loopback> {
  const posts: unknown[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url.startsWith('/flags/definitions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ flags: definitions, group_type_mapping: {}, cohorts: {} }));
      return;
    }
    if (req.method === 'POST' && url.startsWith('/flags/')) {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        posts.push(body === '' ? {} : JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ featureFlags: {}, featureFlagPayloads: {} }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    posts,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

let servers: Loopback[] = [];
beforeEach(() => {
  servers = [];
});
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function loopback(definitions: FlagDefinition[]): Promise<Loopback> {
  const server = await startLoopback(definitions);
  servers.push(server);
  return server;
}

describe('equal value vs the poller — the seeded snapshot resolves identically to the fetched one', () => {
  test('every flag resolves to the SAME value + payload static-seeded as via the poller fetch', async () => {
    // The poller side: a real DefinitionPoller fetching the WIRE definitions over a real socket.
    const server = await loopback(WIRE_DEFINITIONS);
    const poller = new DefinitionPoller({
      definitionsEndpoint: server.origin,
      definitionsKey: 'privileged-key',
      token: 'project-token',
      pollIntervalMs: 60_000,
      fetch,
    });
    const local: LocalEvalCapability = { poller, onlyLocally: false };
    const pollerAdapter = new HttpFlagAdapter<DefaultTaxonomyShape>({
      key: 'project-token',
      flagEndpoint: server.origin,
      fetch,
      local,
    });
    await poller.start();

    // The static side: seeded from the NEUTRAL definitions via config alone.
    const staticClient = createFlagClient({
      key: 'project-token',
      staticDefinitions: STATIC_DEFINITIONS,
      onlyEvaluateLocally: true,
    });

    const pollerSet = await pollerAdapter.evaluate(CONTEXT);
    const staticSet = await staticClient.evaluate(CONTEXT);

    for (const key of ['simple-flag', 'multivariate-flag', 'prop-flag']) {
      expect(staticSet.getFlag(key)).toBe(pollerSet.getFlag(key));
      expect(staticSet.getPayload(key)).toEqual(pollerSet.getPayload(key));
      expect(staticSet.isEnabled(key)).toBe(pollerSet.isEnabled(key));
    }
    // And they match the reference-correct ground truth, not just each other.
    expect(staticSet.getFlag('multivariate-flag')).toBe('second-variant');
    expect(staticSet.getPayload('multivariate-flag')).toEqual({ tier: 'silver' });
    // The poller path posted ZERO remote /flags calls (all decided locally) — same as the static path.
    expect(server.posts).toHaveLength(0);

    pollerAdapter.stop();
    poller.stop();
    staticClient.stop();
  });

  test('a flipped rollout boundary flips the static-seeded answer — the seed is load-bearing', async () => {
    // simple-flag at 0% admits no one → false, the OPPOSITE of the 100% seed. Proves the seed feeds
    // the real evaluator (a vacuous seed would not tell these apart).
    const zeroRollout: FeatureFlagDefinition = {
      key: 'simple-flag',
      enabled: true,
      conditions: [{ propertyFilters: [], rolloutPercentage: 0 }],
    };
    const client = createFlagClient({
      key: 'k',
      staticDefinitions: [zeroRollout],
      onlyEvaluateLocally: true,
    });

    const set = await client.evaluate(CONTEXT);
    expect(set.getFlag('simple-flag')).toBe(false);

    client.stop();
  });
});

// ---------------------------------------------------------------------------------------------
// Malformed static definitions raise LOUDLY at construction — the seed-time input boundary.
// ---------------------------------------------------------------------------------------------

describe('malformed static definitions are rejected at client construction', () => {
  test('a duplicate key throws at construction (via S1 validateDefinitions), before any adapter/network', () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as never);
    expect(() =>
      createFlagClient({
        key: 'k',
        staticDefinitions: [
          { key: 'dup', enabled: true },
          { key: 'dup', enabled: false },
        ],
        onlyEvaluateLocally: true,
        fetch: fetchSpy as never,
      })
    ).toThrow(/invalid flag definitions/i);
    // No adapter constructed ⇒ no side effect: the transport was never touched.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('an out-of-range rollout percentage throws at construction', () => {
    expect(() =>
      createFlagClient({
        key: 'k',
        staticDefinitions: [{ key: 'f', enabled: true, conditions: [{ rolloutPercentage: 150 }] }],
        onlyEvaluateLocally: true,
      })
    ).toThrow(/invalid flag definitions/i);
  });

  test('an empty static-definitions array is a real (empty) route, not a throw — degrades cleanly', async () => {
    // A present-but-empty set is a valid seed: it lowers to an empty snapshot. isReady() is false
    // (no flags), so a local-only client degrades to the neutral unresolved set — no throw, no fetch.
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as never);
    const client = createFlagClient({
      key: 'k',
      staticDefinitions: [],
      onlyEvaluateLocally: true,
      fetch: fetchSpy as never,
    });

    const set = await client.evaluate(CONTEXT);
    expect(set.getAll()).toEqual({});
    expect(set.degraded).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    client.stop();
  });
});
