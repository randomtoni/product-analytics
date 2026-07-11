import type { DefaultTaxonomyShape } from '@randomtoni/analytics-kit';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { HttpFlagAdapter, type LocalEvalCapability } from './http-flag-adapter';
import { DefinitionPoller } from './local';
import type { FlagDefinition } from './local';
import { bucketHash, hashSHA1 } from './local/hash';
import { evaluateFlagLocally } from './local/evaluator';

// E13-S4 — ground-truth + cross-tree parity proof (TS node).
//
// This is the CC-reachable, KEY-LESS layer: a real loopback `http.Server` (a real socket on an
// ephemeral port, the PY8 "real path, not a self-consistent mock" lesson) serves BOTH the canned
// flag DEFINITIONS to the poller AND a canned remote `/flags` response to the shipped remote path.
// The REAL default `fetch` transport crosses a real socket in both directions. We evaluate the SAME
// definitions locally and remotely and assert per-flag agreement, then prove the diff BITES via
// negative controls. The cross-tree hash anchor is re-pinned here as the single named parity vector.
//
// No live backend and no key is needed for anything in this file — the live privileged-key
// ground-truth (diffing local eval against a REAL backend's own bucketing) is a separate,
// skip-if-no-key layer; the loopback + hash-anchor layers below stay fully green with no setup.

// ---------------------------------------------------------------------------------------------
// The known flag set. Their resolved values are the S1 reference-suite consistency vectors (the
// reviewer independently recomputed them against the reference bucketing arithmetic), so the canned
// remote response below is pinned to a values-known-correct external contract — NOT derived from the
// local evaluator (which would be the self-consistent mock PY8 warned against).
// ---------------------------------------------------------------------------------------------

// A 100%-rollout boolean flag → `true` for every actor; payload keyed by the stringified value.
const SIMPLE_FLAG: FlagDefinition = {
  key: 'simple-flag',
  active: true,
  filters: {
    groups: [{ properties: [], rollout_percentage: 100 }],
    payloads: { true: JSON.stringify({ via: 'defn' }) },
  },
};

// The pinned multivariate flag (group 55%, variants 50/20/20/5/5) → `distinct_id_0` lands in
// `second-variant`; payload keyed by that variant.
const MULTIVARIATE_FLAG: FlagDefinition = {
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

// A property-gated flag (plan=pro at 100%) → `true` when the person property is supplied. Proves the
// local matcher reads person properties straight off the FlagContext, matching what the backend does.
const PROP_FLAG: FlagDefinition = {
  key: 'prop-flag',
  active: true,
  filters: { groups: [{ properties: [{ key: 'plan', value: 'pro' }], rollout_percentage: 100 }] },
};

const KNOWN_DEFINITIONS = [SIMPLE_FLAG, MULTIVARIATE_FLAG, PROP_FLAG];

// The ground-truth CONTEXT: distinct_id_0 with plan=pro. Same context drives both local + remote.
const GROUND_TRUTH_CONTEXT = { distinctId: 'distinct_id_0', personProperties: { plan: 'pro' } };

// The resolved values a REAL remote eval of KNOWN_DEFINITIONS returns for GROUND_TRUTH_CONTEXT —
// pinned to the S1 reference vectors, the values-known-correct external contract. The canned remote
// response the loopback serves is built from THIS, so a passing local-vs-remote diff means local eval
// agrees with the reference-correct backend answer, not with a mock echoing the local result.
const GROUND_TRUTH_FLAGS: Record<string, string | boolean> = {
  'simple-flag': true,
  'multivariate-flag': 'second-variant',
  'prop-flag': true,
};
const GROUND_TRUTH_PAYLOADS: Record<string, unknown> = {
  'simple-flag': { via: 'defn' },
  'multivariate-flag': { tier: 'silver' },
};

// ---------------------------------------------------------------------------------------------
// The loopback server — a real localhost `http.Server`. GET /flags/definitions serves the canned
// definitions to the poller; POST /flags/ serves a canned remote response to the shipped round-trip.
// It records every POST body so a negative control can assert whether — and for which keys — the
// remote path was actually reached over the socket.
// ---------------------------------------------------------------------------------------------

interface RemoteResponse {
  featureFlags?: Record<string, string | boolean>;
  featureFlagPayloads?: Record<string, unknown>;
}

interface Loopback {
  origin: string;
  posts: Array<{ distinct_id?: string; flag_keys_to_evaluate?: string[] }>;
  definitionPaths: string[];
  close: () => Promise<void>;
}

async function startLoopback(opts: {
  definitions: FlagDefinition[];
  remote: RemoteResponse;
}): Promise<Loopback> {
  const posts: Loopback['posts'] = [];
  const definitionPaths: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url.startsWith('/flags/definitions')) {
      definitionPaths.push(url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ flags: opts.definitions, group_type_mapping: {}, cohorts: {} }));
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
        res.end(JSON.stringify(opts.remote));
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
    definitionPaths,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

// Build a local-capable adapter pointed at the loopback origin, using the REAL default fetch (a real
// socket), and await the poller's first load so the local branch is live before the evaluate.
async function makeLocalAdapterAgainst(origin: string): Promise<{
  adapter: HttpFlagAdapter<DefaultTaxonomyShape>;
  poller: DefinitionPoller;
}> {
  const poller = new DefinitionPoller({
    definitionsEndpoint: origin,
    definitionsKey: 'privileged-key',
    token: 'project-token',
    pollIntervalMs: 60_000,
    fetch,
  });
  const local: LocalEvalCapability = { poller, onlyLocally: false };
  const adapter = new HttpFlagAdapter<DefaultTaxonomyShape>({
    key: 'project-token',
    flagEndpoint: origin,
    fetch,
    local,
  });
  await poller.start();
  return { adapter, poller };
}

// A pure remote-only adapter pointed at the loopback origin (real socket, real fetch). This is the
// "backend answer" side of the diff: it POSTs to /flags/ and reads the canned ground-truth response.
function makeRemoteAdapterAgainst(origin: string): HttpFlagAdapter<DefaultTaxonomyShape> {
  return new HttpFlagAdapter<DefaultTaxonomyShape>({
    key: 'project-token',
    flagEndpoint: origin,
    fetch,
  });
}

let servers: Loopback[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});
beforeEach(() => {
  servers = [];
});

async function loopback(opts: { definitions: FlagDefinition[]; remote: RemoteResponse }): Promise<Loopback> {
  const server = await startLoopback(opts);
  servers.push(server);
  return server;
}

// ---------------------------------------------------------------------------------------------
// Layer 1 — loopback ground-truth (KEY-LESS): local eval agrees with the real remote answer.
// ---------------------------------------------------------------------------------------------

describe('layer 1 — loopback ground-truth: local eval agrees with the remote answer per-flag', () => {
  test('every flag resolves to the SAME value + payload locally and remotely over a real socket', async () => {
    const server = await loopback({
      definitions: KNOWN_DEFINITIONS,
      remote: { featureFlags: GROUND_TRUTH_FLAGS, featureFlagPayloads: GROUND_TRUTH_PAYLOADS },
    });

    const { adapter: local, poller } = await makeLocalAdapterAgainst(server.origin);
    const remote = makeRemoteAdapterAgainst(server.origin);

    const localSet = await local.evaluate(GROUND_TRUTH_CONTEXT);
    const remoteSet = await remote.evaluate(GROUND_TRUTH_CONTEXT);

    // Per-flag agreement: value + payload identical across the local and remote strategies.
    for (const key of Object.keys(GROUND_TRUTH_FLAGS)) {
      expect(localSet.getFlag(key)).toBe(remoteSet.getFlag(key));
      expect(localSet.getPayload(key)).toEqual(remoteSet.getPayload(key));
      expect(localSet.isEnabled(key)).toBe(remoteSet.isEnabled(key));
    }
    // And they match the reference-correct ground truth (not just each other).
    expect(localSet.getFlag('simple-flag')).toBe(true);
    expect(localSet.getFlag('multivariate-flag')).toBe('second-variant');
    expect(localSet.getFlag('prop-flag')).toBe(true);
    expect(localSet.getPayload('multivariate-flag')).toEqual({ tier: 'silver' });

    local.stop();
    poller.stop();
  });

  test('the definitions AND the remote response both cross the real socket (the remote path fired)', async () => {
    // The local eval here is INCONCLUSIVE for one flag (experience continuity) so the shipped remote
    // path is genuinely exercised over the socket — proving the fallback hits the real transport.
    const continuity: FlagDefinition = {
      key: 'needs-remote',
      active: true,
      ensure_experience_continuity: true,
      filters: { groups: [{ properties: [], rollout_percentage: 100 }] },
    };
    const server = await loopback({
      definitions: [SIMPLE_FLAG, continuity],
      remote: { featureFlags: { 'needs-remote': 'server-value' }, featureFlagPayloads: {} },
    });

    const { adapter: local, poller } = await makeLocalAdapterAgainst(server.origin);
    const set = await local.evaluate(GROUND_TRUTH_CONTEXT);

    // The locally-decidable flag resolved locally; the inconclusive one came from the real remote hit.
    expect(set.getFlag('simple-flag')).toBe(true);
    expect(set.getFlag('needs-remote')).toBe('server-value');
    // Exactly one POST crossed the socket, narrowed to only the flag local eval couldn't decide.
    expect(server.posts).toHaveLength(1);
    expect(server.posts[0].flag_keys_to_evaluate).toEqual(['needs-remote']);

    local.stop();
    poller.stop();
  });

  test('the definitions GET carries send_cohorts + token on the wire (over the real socket)', async () => {
    // The S1/S3 forward-note: confirm send_cohorts on the wire — OVER THE SOCKET, not on the poller's
    // private URL. The definitions GET carries the send_cohorts query param (asking the endpoint to
    // include the cohort map so a static-cohort flag is locally decidable rather than an inconclusive
    // RequiresServerEvaluation). The loopback records the path of every definitions GET it actually
    // serves, so we assert the query param on the REAL request the poller issued.
    const server = await loopback({
      definitions: KNOWN_DEFINITIONS,
      remote: { featureFlags: GROUND_TRUTH_FLAGS, featureFlagPayloads: GROUND_TRUTH_PAYLOADS },
    });
    const { adapter: local, poller } = await makeLocalAdapterAgainst(server.origin);

    expect(server.definitionPaths.length).toBeGreaterThanOrEqual(1);
    expect(server.definitionPaths[0]).toContain('send_cohorts');
    expect(server.definitionPaths[0]).toContain('token=project-token');

    local.stop();
    poller.stop();
  });
});

// ---------------------------------------------------------------------------------------------
// Negative controls (the PY8 lesson — the test CAN fail).
// ---------------------------------------------------------------------------------------------

describe('negative controls — the diff is non-vacuous', () => {
  // The zero-POST complement of layer 1's fallback-FIRED test: there one flag was inconclusive so a
  // POST crossed the socket; here every flag decides locally so NONE does — the deliberate opposites.
  test('a fully-local-decidable set issues ZERO remote POSTs over the socket', async () => {
    const server = await loopback({
      definitions: KNOWN_DEFINITIONS,
      remote: { featureFlags: GROUND_TRUTH_FLAGS, featureFlagPayloads: GROUND_TRUTH_PAYLOADS },
    });
    const { adapter: local, poller } = await makeLocalAdapterAgainst(server.origin);

    const set = await local.evaluate(GROUND_TRUTH_CONTEXT);

    // All three flags decide locally → the remote path is never reached.
    expect(set.getFlag('simple-flag')).toBe(true);
    expect(set.degraded).toBe(false);
    expect(server.posts).toHaveLength(0);

    local.stop();
    poller.stop();
  });

  test('a deliberately-WRONG remote answer DISAGREES with local eval — proving the diff would catch drift', async () => {
    // The loopback serves a remote value that a correct backend would NOT return for this actor. If
    // the ground-truth diff were vacuous (a self-consistent mock), this would still "agree". It must
    // NOT: local eval computes the reference-correct value and the two disagree.
    const server = await loopback({
      definitions: [MULTIVARIATE_FLAG],
      remote: { featureFlags: { 'multivariate-flag': 'third-variant' }, featureFlagPayloads: {} },
    });
    const { adapter: local, poller } = await makeLocalAdapterAgainst(server.origin);
    const remote = makeRemoteAdapterAgainst(server.origin);

    const localSet = await local.evaluate(GROUND_TRUTH_CONTEXT);
    const remoteSet = await remote.evaluate(GROUND_TRUTH_CONTEXT);

    // Local eval lands in the reference-correct 'second-variant'; the (wrong) remote says 'third'.
    expect(localSet.getFlag('multivariate-flag')).toBe('second-variant');
    expect(remoteSet.getFlag('multivariate-flag')).toBe('third-variant');
    // The diff BITES: a drift between local eval and the backend is caught, not silently passed.
    expect(localSet.getFlag('multivariate-flag')).not.toBe(remoteSet.getFlag('multivariate-flag'));

    local.stop();
    poller.stop();
  });

  test('a flipped rollout boundary changes the local answer — the hash gate is load-bearing', async () => {
    // simple-flag at 0% admits no one → false, the OPPOSITE of the 100% ground truth. A vacuous test
    // (one that never actually gates on the hash) could not tell these apart.
    const zeroRollout: FlagDefinition = {
      key: 'simple-flag',
      active: true,
      filters: { groups: [{ properties: [], rollout_percentage: 0 }] },
    };
    const server = await loopback({ definitions: [zeroRollout], remote: { featureFlags: {} } });
    const { adapter: local, poller } = await makeLocalAdapterAgainst(server.origin);

    const set = await local.evaluate(GROUND_TRUTH_CONTEXT);

    // Flipped boundary → false, distinct from the 100% ground-truth `true`.
    expect(set.getFlag('simple-flag')).toBe(false);

    local.stop();
    poller.stop();
  });
});

// ---------------------------------------------------------------------------------------------
// Layer 2 — the cross-tree hash anchor (KEY-LESS). This is the SINGLE named parity vector both
// trees bind to. S1 (this TS suite) and S3 (the Python suite) each assert these EXACT literals in
// their own suites; a drift in either tree's hash fails ITS suite. S4 names the vector here in one
// place so the cross-tree identity is explicit — the load-bearing invariant across both trees AND a
// real backend's bucketing (the loopback layer 1 above, and the live layer in the Python suite).
// ---------------------------------------------------------------------------------------------

describe('layer 2 — cross-tree hash anchor: the single pinned parity vector (identical in Python S3)', () => {
  test('tier 1 — the SHA1 primitive matches the pinned digest byte-for-byte', () => {
    expect(hashSHA1('some-flag.some_distinct_id')).toBe('e4ce124e800a818c63099f95fa085dc2b620e173');
  });

  test('tier 2 — the exact bucketing floats (rollout salt + variant salt) match', () => {
    expect(bucketHash('simple-flag', 'distinct_id_0')).toBe(0.78369637642204315);
    expect(bucketHash('simple-flag', 'distinct_id_1')).toBe(0.33970699269954008);
    expect(bucketHash('multivariate-flag', 'distinct_id_0', 'variant')).toBe(0.61864545379303792);
  });

  test('tier 3 — simple-flag at 45% over distinct_id_{0..9} matches the pinned boolean vector', () => {
    const def: FlagDefinition = {
      key: 'simple-flag',
      active: true,
      filters: { groups: [{ properties: [], rollout_percentage: 45 }] },
    };
    const out: Array<string | boolean> = [];
    for (let i = 0; i < 10; i++) {
      out.push(evaluateFlagLocally(def, `distinct_id_${i}`, {}, {}));
    }
    expect(out).toEqual([false, true, true, false, true, false, false, true, false, true]);
  });
});

// ---------------------------------------------------------------------------------------------
// Bar re-proof (structural — asserted in S2 already; recorded here as satisfied at the epic level).
// ---------------------------------------------------------------------------------------------

describe('bar re-proof for local eval', () => {
  test('bar A — a remote-ONLY adapter (no local capability) still satisfies the one evaluate', async () => {
    // Local eval is a capability an adapter MAY add: a remote-only adapter over the loopback resolves
    // through the SAME evaluate method with no local machinery at all.
    const server = await loopback({
      definitions: [],
      remote: { featureFlags: { 'simple-flag': true }, featureFlagPayloads: {} },
    });
    const remoteOnly = makeRemoteAdapterAgainst(server.origin);
    const set = await remoteOnly.evaluate(GROUND_TRUTH_CONTEXT);
    expect(set.getFlag('simple-flag')).toBe(true);
  });

  test('bar B — enabling local eval is config-only: definitions endpoint + privileged key select it', async () => {
    const server = await loopback({
      definitions: KNOWN_DEFINITIONS,
      remote: { featureFlags: GROUND_TRUTH_FLAGS, featureFlagPayloads: GROUND_TRUTH_PAYLOADS },
    });
    // A local-capable adapter is assembled purely from config values (endpoint + privileged key);
    // no library edit toggles it on. It then resolves the ground-truth set with zero remote POSTs.
    const { adapter: local, poller } = await makeLocalAdapterAgainst(server.origin);
    const set = await local.evaluate(GROUND_TRUTH_CONTEXT);
    expect(set.getFlag('simple-flag')).toBe(true);
    expect(server.posts).toHaveLength(0);
    local.stop();
    poller.stop();
  });
});
