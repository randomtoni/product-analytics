import { gzipSync } from 'node:zlib';
import { afterEach, expect, test, vi } from 'vitest';
import { createFakeDbExecute } from '../query/db-execute.fixtures';
import type { WireBatchEnvelope, WireEvent } from '../wire-mapper';
import type { ReceiverHeaders } from './receiver';

// The S3 fake seam is injected at the driver-build boundary: mock `createDefaultDbExecute` so the
// factory reads `warehouseDsn` and builds a fake `DbExecute` from it — no real Postgres, no `pg`
// peer. `vi.mock` is hoisted; the factory + core (SUT) import the mocked module, exactly mirroring
// E17-S4's warehouse-selection tests. Every test re-imports the SUT fresh so a per-test mock impl
// (via `mockImplementation`) is honoured.
const { defaultDbExecuteMock } = vi.hoisted(() => ({ defaultDbExecuteMock: vi.fn() }));

vi.mock('../query/default-db-execute', () => ({
  createDefaultDbExecute: defaultDbExecuteMock,
}));

async function importFactory() {
  const mod = await import('./create-receiver-from-config');
  return mod.createReceiverFromConfig;
}

function wireEvent(overrides: Partial<WireEvent> = {}): WireEvent {
  return {
    uuid: 'dd-1',
    event: 'order_placed',
    distinct_id: 'user-1',
    properties: { amount: 42 },
    timestamp: '2026-07-08T00:00:00.000Z',
    ...overrides,
  };
}

function envelope(batch: WireEvent[]): WireBatchEnvelope {
  return { api_key: 'proj-key', batch, sent_at: '2026-07-08T12:00:00.000Z' };
}

function rawBody(env: WireBatchEnvelope): Buffer {
  return Buffer.from(JSON.stringify(env), 'utf8');
}

const RAW_HEADERS: ReceiverHeaders = { 'content-type': 'application/json' };

afterEach(() => {
  vi.restoreAllMocks();
  defaultDbExecuteMock.mockReset();
});

// --- the factory reads `warehouseDsn` and builds the `DbExecute` at the boundary ----------

test('reads warehouseDsn and builds the default DbExecute from it (S3 driver injected)', async () => {
  const fake = createFakeDbExecute();
  defaultDbExecuteMock.mockReturnValue(fake.execute);
  const createReceiverFromConfig = await importFactory();

  const receiver = createReceiverFromConfig({ warehouseDsn: 'postgres://localhost/analytics' });

  // The DSN was read at the boundary and threaded into the S3 driver build — object arg shape.
  expect(defaultDbExecuteMock).toHaveBeenCalledTimes(1);
  expect(defaultDbExecuteMock).toHaveBeenCalledWith({ warehouseDsn: 'postgres://localhost/analytics' });
  expect(typeof receiver.receive).toBe('function');
});

test('the built DbExecute is the one the returned receiver routes its upsert through', async () => {
  const fake = createFakeDbExecute();
  defaultDbExecuteMock.mockReturnValue(fake.execute);
  const createReceiverFromConfig = await importFactory();

  const receiver = createReceiverFromConfig({ warehouseDsn: 'postgres://localhost/analytics' });
  const outcome = await receiver.receive(rawBody(envelope([wireEvent()])), RAW_HEADERS);

  // The receiver upserts through the injected fake — proof the factory wired the built DbExecute
  // into the core (not some other seam).
  expect(outcome).toEqual({ outcome: 'accepted', accepted: 1 });
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].sql).toContain('INSERT INTO');
  expect(fake.calls[0].params).toContain('dd-1');
});

test('a gzipped body decodes through the DSN-built receiver (end-to-end via the fake seam)', async () => {
  const fake = createFakeDbExecute();
  defaultDbExecuteMock.mockReturnValue(fake.execute);
  const createReceiverFromConfig = await importFactory();

  const receiver = createReceiverFromConfig({ warehouseDsn: 'postgres://localhost/analytics' });
  const gzipped = gzipSync(rawBody(envelope([wireEvent()])));
  const outcome = await receiver.receive(gzipped, {
    'content-type': 'application/json',
    'content-encoding': 'gzip',
  });

  expect(outcome).toEqual({ outcome: 'accepted', accepted: 1 });
  expect(fake.calls).toHaveLength(1);
});

// --- the DSN is read at the boundary, NEVER stored on the returned receiver ----------------

test('the returned receiver never holds the DSN — its only injected field is the opaque DbExecute', async () => {
  const dsn = 'postgres://user:secret@localhost/analytics';
  const fake = createFakeDbExecute();
  defaultDbExecuteMock.mockReturnValue(fake.execute);
  const createReceiverFromConfig = await importFactory();

  const receiver = createReceiverFromConfig({ warehouseDsn: dsn });

  // A credential-shaped value read at the factory boundary must not be reachable on the working
  // receiver — no own value equals or contains the DSN / secret.
  expect(JSON.stringify(receiver)).not.toContain('secret');
  expect(JSON.stringify(receiver)).not.toContain('postgres://');
  for (const value of Object.values(receiver as unknown as Record<string, unknown>)) {
    expect(value).not.toBe(dsn);
    expect(typeof value === 'string' && value.includes('postgres://')).toBe(false);
  }
});

// --- lazy import proven: constructs with no `pg`/`warehouse` peer installed ----------------

test('constructs the receiver without the `warehouse` peer installed (lazy driver build)', async () => {
  // The real `createDefaultDbExecute` defers the optional `pg` peer load to first exec call; the
  // factory + returned receiver construct with nothing installed. Here the mock stands in for the
  // driver build, so the assertion is that selection + construction NEVER throw at build time.
  defaultDbExecuteMock.mockReturnValue(createFakeDbExecute().execute);
  const createReceiverFromConfig = await importFactory();

  expect(() => createReceiverFromConfig({ warehouseDsn: 'postgres://localhost/analytics' })).not.toThrow();
});

// --- absent `warehouseDsn` ⇒ a CLEAR NEUTRAL ERROR naming the missing field ----------------

test('absent warehouseDsn throws a clear neutral error naming the missing field (NOT a no-op)', async () => {
  const createReceiverFromConfig = await importFactory();

  expect(() => createReceiverFromConfig({})).toThrow(/warehouseDsn/);
});

test('the absent-DSN error is transport- and vendor-free and NEVER builds a driver (no silent drop)', async () => {
  const createReceiverFromConfig = await importFactory();

  let message = '';
  try {
    createReceiverFromConfig({});
  } catch (error) {
    message = (error as Error).message;
  }

  // Names the missing field; carries no vendor / no HTTP status vocabulary.
  expect(message).toContain('warehouseDsn');
  expect(message).not.toMatch(/posthog/i);
  expect(message).not.toMatch(/\b(200|400|500)\b/);
  // The write-side diverges from the query factory's no-op: no driver is built, no receiver returned.
  expect(defaultDbExecuteMock).not.toHaveBeenCalled();
});

test('an empty-string warehouseDsn is a PRESENT value (still builds — presence, not truthiness)', async () => {
  const fake = createFakeDbExecute();
  defaultDbExecuteMock.mockReturnValue(fake.execute);
  const createReceiverFromConfig = await importFactory();

  // Selection is by field PRESENCE (`!== undefined`), mirroring `createQueryClient`'s
  // `warehouseDsn !== undefined` rung — an explicitly-supplied empty string is present, so it is
  // threaded to the driver build (the driver decides its own validity), not rejected as absent.
  expect(() => createReceiverFromConfig({ warehouseDsn: '' })).not.toThrow();
  expect(defaultDbExecuteMock).toHaveBeenCalledWith({ warehouseDsn: '' });
});
