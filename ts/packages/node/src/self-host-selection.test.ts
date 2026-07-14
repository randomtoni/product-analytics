import type { DefaultTaxonomyShape } from '@randomtoni/analytics-kit';
import { defineTaxonomy } from '@randomtoni/analytics-kit';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createQueryClient } from './query/create-query-client';
import { HttpQueryAdapter } from './query/http-query-adapter';
import { QueryNoop } from './query/query-noop';
import { WarehouseQueryAdapter } from './query/warehouse-query-adapter';
import { createFakeDbExecute } from './query/db-execute.fixtures';
import { createFlagClient } from './flags/create-flag-client';
import type { FeatureFlagDefinition } from './flags/local/neutral-definition';
import { FlagNoop } from './flags/flag-noop';
import { HttpFlagAdapter } from './flags/http-flag-adapter';
import { createReceiverFromConfig } from './receiver/create-receiver-from-config';

// E21-S2 — the self-host-selection standing gate (E2, protocol-neutrality).
//
// This is the SECOND, orthogonal neutrality gate (the name scan proves observability neutrality;
// this proves BEHAVIORAL neutrality). Given a self-host config it asserts, at the SELECTION LEVEL,
// that the neutral self-host backends are the ones the factories CONSTRUCT — never the HTTP/wire
// path. It consolidates three assertions that already live green in the per-capability suites
// (create-query-client / static-definitions / create-receiver-from-config) into ONE named standing
// behavioral unit so a regression in ANY rung fails one clearly-named gate. Selection-level, not
// URL-string or AST: the strongest form is "the HTTP adapter was never even constructed" — assert
// the returned TYPE (and the flag client having no reachable URL: its injected fetch is never hit).
// Fast: fake DbExecute / injected fetch, NO real Postgres, NO network — runs in the fast inner loop.

const TAXONOMY = defineTaxonomy({
  events: { order_placed: { amount: 'number' }, signed_up: {} },
  traits: { plan: 'string' },
});

// A fake DSN — never a real Postgres. The TS default driver is LAZY (imports `pg` only on first
// `execute`), so the warehouse rung constructs clean against this fake DSN with NO mock and NO peer.
const FAKE_DSN = 'postgres://localhost/analytics';

// The neutral static flag definitions a self-host consumer authors — a 100%-rollout boolean flag.
const STATIC_DEFINITIONS: FeatureFlagDefinition[] = [
  {
    key: 'simple-flag',
    enabled: true,
    conditions: [{ propertyFilters: [], rolloutPercentage: 100 }],
  },
];

// The DSN-built exec boundary the receiver factory reads. Mocked so the receiver rung is proven
// with a fake DbExecute (no `pg` peer, no Postgres). The mock DEFAULTS to the real lazy export
// (via importActual) so the query rung below still exercises the genuine lazy driver with no mock
// behaviour of its own — only the receiver test installs a per-test implementation.
const { defaultDbExecuteMock } = vi.hoisted(() => ({ defaultDbExecuteMock: vi.fn() }));
vi.mock('./query/default-db-execute', async () => {
  const actual = await vi.importActual<typeof import('./query/default-db-execute')>(
    './query/default-db-execute'
  );
  defaultDbExecuteMock.mockImplementation(actual.createDefaultDbExecute);
  return { ...actual, createDefaultDbExecute: defaultDbExecuteMock };
});

afterEach(() => {
  vi.restoreAllMocks();
  defaultDbExecuteMock.mockReset();
  defaultDbExecuteMock.mockImplementation(async () => ({ rows: [], columns: [] }));
});

describe('self-host-selection gate — a self-host config selects the neutral backends (behavioral neutrality)', () => {
  // --- Query rung: warehouseDsn present ⇒ the warehouse adapter, NOT the HTTP adapter ---------
  test('query: warehouseDsn selects the WarehouseQueryAdapter, never the HTTP adapter (no fetch, no warn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.fn(async () => ({ status: 200 }) as never);

    const client = createQueryClient({
      warehouseDsn: FAKE_DSN,
      taxonomy: TAXONOMY,
      fetch: fetchSpy as never,
    });

    // Selection-level: the constructed TYPE is the warehouse rung; the HTTP adapter was never built.
    expect(client).toBeInstanceOf(WarehouseQueryAdapter);
    expect(client).not.toBeInstanceOf(HttpQueryAdapter);
    expect(client).not.toBeInstanceOf(QueryNoop);
    // The warehouse rung wins by field PRESENCE ahead of the HTTP ladder: no warn, no egress.
    expect(warn).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('query: warehouseDsn wins over a full personalKey+queryEndpoint HTTP config (precedence)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createQueryClient({
      warehouseDsn: FAKE_DSN,
      personalKey: 'pk_read',
      queryEndpoint: 'https://query.example',
      projectId: 'proj-1',
      taxonomy: TAXONOMY,
    });

    // Even fully HTTP-configured, presence of the DSN takes precedence — HTTP is never reached.
    expect(client).toBeInstanceOf(WarehouseQueryAdapter);
    expect(client).not.toBeInstanceOf(HttpQueryAdapter);
    expect(warn).not.toHaveBeenCalled();
  });

  // --- Flags rung: static definitions ⇒ a local-only client with no reachable flag URL --------
  test('flags: static definitions + onlyEvaluateLocally selects the real adapter, local-only, and never fetches', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The recording transport: ANY call is a self-host neutrality failure. A static-seeded local-only
    // client resolves entirely in-process — no definition fetch, no /flags/ round-trip, no URL.
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as never);

    const client = createFlagClient({
      key: 'k',
      staticDefinitions: STATIC_DEFINITIONS,
      onlyEvaluateLocally: true,
      fetch: fetchSpy as never,
    });

    // A static-defs config is a real (local) route, so it is NOT downgraded to the no-op.
    expect(client).toBeInstanceOf(HttpFlagAdapter);
    expect(client).not.toBeInstanceOf(FlagNoop);
    expect(warn).not.toHaveBeenCalled();

    const set = await client.evaluate({ distinctId: 'distinct_id_0' });

    // Resolved from the seeded snapshot, and the transport was NEVER hit — the local-only client is
    // structurally unable to fetch (no flag/definitions URL): zero definition GETs, zero /flags/ POSTs.
    expect(set.getFlag('simple-flag')).toBe(true);
    expect(set.degraded).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();

    (client as HttpFlagAdapter<DefaultTaxonomyShape>).stop();
  });

  // --- Receiver rung: warehouseDsn ⇒ a DSN-built DbExecute writer, not an HTTP writer ----------
  test('receiver: createReceiverFromConfig builds a DSN-targeted DbExecute writer (not an HTTP writer)', () => {
    const fake = createFakeDbExecute();
    defaultDbExecuteMock.mockReturnValue(fake.execute);

    const receiver = createReceiverFromConfig({ warehouseDsn: FAKE_DSN });

    // Selection-level: the DSN was read at the boundary and threaded into the DSN-built DbExecute —
    // the neutral warehouse writer, not an HTTP transport. The receiver holds only the opaque exec.
    expect(defaultDbExecuteMock).toHaveBeenCalledTimes(1);
    expect(defaultDbExecuteMock).toHaveBeenCalledWith({ warehouseDsn: FAKE_DSN });
    expect(typeof receiver.receive).toBe('function');
  });
});
