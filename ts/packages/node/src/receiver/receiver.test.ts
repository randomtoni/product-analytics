import { gzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { createFakeDbExecute } from '../query/db-execute.fixtures';
import type { WireBatchEnvelope, WireEvent } from '../wire-mapper';
import { createReceiver, type ReceiverHeaders } from './receiver';

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

function gzipBody(env: WireBatchEnvelope): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(env), 'utf8'));
}

const RAW_HEADERS: ReceiverHeaders = { 'content-type': 'application/json' };
const GZIP_HEADERS: ReceiverHeaders = {
  'content-type': 'application/json',
  'content-encoding': 'gzip',
};

const FIXED_NOW = new Date('2026-07-10T09:30:00.000Z');

// --- envelope parse + upsert SQL/params (raw JSON) --------------------------------------

test('parses the node batch envelope and upserts each event via ON CONFLICT (uuid) DO NOTHING', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  const result = await receiver.receive(rawBody(envelope([wireEvent()])), RAW_HEADERS, FIXED_NOW);

  expect(result).toEqual({ outcome: 'accepted', accepted: 1 });
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].sql).toBe(
    'INSERT INTO events (distinct_id, event, timestamp, uuid, properties) VALUES ' +
      '($1, $2, $3, $4, $5) ON CONFLICT (uuid) DO NOTHING'
  );
  expect(fake.calls[0].params).toEqual([
    'user-1',
    'order_placed',
    '2026-07-08T00:00:00.000Z',
    'dd-1',
    JSON.stringify({ amount: 42 }),
  ]);
});

test('binds SQL params — never string-interpolated (no event value appears in the SQL text)', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  await receiver.receive(
    rawBody(envelope([wireEvent({ event: "'; DROP TABLE events; --", distinct_id: 'user-x' })])),
    RAW_HEADERS,
    FIXED_NOW
  );

  expect(fake.calls[0].sql).not.toContain('DROP TABLE');
  expect(fake.calls[0].sql).not.toContain('user-x');
  expect(fake.calls[0].params).toContain("'; DROP TABLE events; --");
});

// --- multi-row batch: one statement, placeholders in lockstep ---------------------------

test('a multi-event batch is one statement with $N placeholders in lockstep (5 per event)', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  const result = await receiver.receive(
    rawBody(
      envelope([wireEvent({ uuid: 'a' }), wireEvent({ uuid: 'b' }), wireEvent({ uuid: 'c' })])
    ),
    RAW_HEADERS,
    FIXED_NOW
  );

  expect(result).toEqual({ outcome: 'accepted', accepted: 3 });
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].sql).toBe(
    'INSERT INTO events (distinct_id, event, timestamp, uuid, properties) VALUES ' +
      '($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10), ($11, $12, $13, $14, $15) ' +
      'ON CONFLICT (uuid) DO NOTHING'
  );
  expect(fake.calls[0].params).toHaveLength(15);
  expect(fake.calls[0].params?.slice(5, 10)).toEqual([
    'user-1',
    'order_placed',
    '2026-07-08T00:00:00.000Z',
    'b',
    JSON.stringify({ amount: 42 }),
  ]);
});

// --- idempotency on uuid ----------------------------------------------------------------

test('idempotency: the upsert carries ON CONFLICT (uuid) DO NOTHING so a re-delivered uuid does not double-write', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  await receiver.receive(rawBody(envelope([wireEvent({ uuid: 'retry-key' })])), RAW_HEADERS, FIXED_NOW);
  await receiver.receive(
    rawBody(envelope([wireEvent({ uuid: 'retry-key', properties: { amount: 99 } })])),
    RAW_HEADERS,
    FIXED_NOW
  );

  // Both deliveries emit the SAME idempotent upsert form; dedupe happens on the DB's UNIQUE(uuid).
  for (const call of fake.calls) {
    expect(call.sql).toContain('ON CONFLICT (uuid) DO NOTHING');
  }
});

test('an intra-batch duplicate uuid is safe (DO NOTHING) — no pre-dedupe pass, both rows in one statement', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  const result = await receiver.receive(
    rawBody(envelope([wireEvent({ uuid: 'dup' }), wireEvent({ uuid: 'dup' })])),
    RAW_HEADERS,
    FIXED_NOW
  );

  expect(result).toEqual({ outcome: 'accepted', accepted: 2 });
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].params).toHaveLength(10);
  expect(fake.calls[0].sql).toContain('ON CONFLICT (uuid) DO NOTHING');
});

// --- properties jsonb: verbatim, {} when absent, trait/group nesting persisted as-is ----

test('properties binds verbatim as a JSON string (the driver casts to jsonb)', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  await receiver.receive(
    rawBody(envelope([wireEvent({ properties: { plan: 'pro', nested: { a: 1 } } })])),
    RAW_HEADERS,
    FIXED_NOW
  );

  expect(fake.calls[0].params?.[4]).toBe(JSON.stringify({ plan: 'pro', nested: { a: 1 } }));
});

test('absent properties binds an empty JSON object {} (never NULL — the column is NOT NULL)', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  await receiver.receive(
    rawBody(envelope([wireEvent({ properties: undefined })])),
    RAW_HEADERS,
    FIXED_NOW
  );

  expect(fake.calls[0].params?.[4]).toBe('{}');
});

test('trait/group keys stay nested inside properties, persisted as-is with no column named after them', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  const traitProps = { set: { plan: 'pro' }, set_once: { signup: '2026' } };
  const groupProps = { group_type: 'company', group_key: 'acme', group_set: { seats: 10 } };

  await receiver.receive(
    rawBody(
      envelope([
        wireEvent({ uuid: 't', event: 'set_traits', properties: traitProps }),
        wireEvent({ uuid: 'g', event: 'set_group_traits', properties: groupProps }),
      ])
    ),
    RAW_HEADERS,
    FIXED_NOW
  );

  // No trait/group key is a column — the column list is exactly the frozen 5.
  expect(fake.calls[0].sql).toContain(
    'INSERT INTO events (distinct_id, event, timestamp, uuid, properties)'
  );
  for (const key of ['set', 'set_once', 'group_type', 'group_key', 'group_set']) {
    expect(fake.calls[0].sql).not.toContain(`, ${key},`);
    expect(fake.calls[0].sql).not.toContain(`(${key},`);
  }
  // The nested bags are persisted verbatim inside the properties param.
  expect(fake.calls[0].params?.[4]).toBe(JSON.stringify(traitProps));
  expect(fake.calls[0].params?.[9]).toBe(JSON.stringify(groupProps));
});

// --- server-receipt-time default --------------------------------------------------------

test('a WireEvent omitting timestamp persists at server-receipt time (one fixed instant per batch)', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  await receiver.receive(
    rawBody(
      envelope([
        wireEvent({ uuid: 'no-ts-1', timestamp: undefined }),
        wireEvent({ uuid: 'no-ts-2', timestamp: undefined }),
      ])
    ),
    RAW_HEADERS,
    FIXED_NOW
  );

  // Both events omitting timestamp take the SAME receipt instant — one arrival per batch.
  expect(fake.calls[0].params?.[2]).toBe('2026-07-10T09:30:00.000Z');
  expect(fake.calls[0].params?.[7]).toBe('2026-07-10T09:30:00.000Z');
});

test('a WireEvent carrying timestamp uses it verbatim (receipt time only fills the absent case)', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  await receiver.receive(
    rawBody(
      envelope([
        wireEvent({ uuid: 'has-ts', timestamp: '2020-01-01T00:00:00.000Z' }),
        wireEvent({ uuid: 'no-ts', timestamp: undefined }),
      ])
    ),
    RAW_HEADERS,
    FIXED_NOW
  );

  expect(fake.calls[0].params?.[2]).toBe('2020-01-01T00:00:00.000Z');
  expect(fake.calls[0].params?.[7]).toBe('2026-07-10T09:30:00.000Z');
});

test('receipt time defaults to a real now when no instant is passed (impure boundary)', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  const before = Date.now();
  await receiver.receive(rawBody(envelope([wireEvent({ timestamp: undefined })])), RAW_HEADERS);
  const after = Date.now();

  const bound = Date.parse(fake.calls[0].params?.[2] as string);
  expect(bound).toBeGreaterThanOrEqual(before);
  expect(bound).toBeLessThanOrEqual(after);
});

// --- conditional decompress -------------------------------------------------------------

test('gunzips the body when Content-Encoding: gzip is present', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  const result = await receiver.receive(gzipBody(envelope([wireEvent()])), GZIP_HEADERS, FIXED_NOW);

  expect(result).toEqual({ outcome: 'accepted', accepted: 1 });
  expect(fake.calls[0].params?.[3]).toBe('dd-1');
});

test('Content-Encoding lookup is case-insensitive (header name and value)', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  const result = await receiver.receive(gzipBody(envelope([wireEvent()])), {
    'Content-Encoding': 'GZIP',
  });

  expect(result).toEqual({ outcome: 'accepted', accepted: 1 });
});

test('parses raw UTF-8 JSON when the Content-Encoding header is absent (send-side fallback)', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  const result = await receiver.receive(rawBody(envelope([wireEvent()])), RAW_HEADERS, FIXED_NOW);

  expect(result).toEqual({ outcome: 'accepted', accepted: 1 });
});

// --- empty batch + malformed body -------------------------------------------------------

test('a valid empty batch is a no-op success with ZERO DB calls (no zero-row INSERT)', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  const result = await receiver.receive(rawBody(envelope([])), RAW_HEADERS, FIXED_NOW);

  expect(result).toEqual({ outcome: 'accepted', accepted: 0 });
  expect(fake.calls).toHaveLength(0);
});

test('a malformed body yields a neutral parse error and never calls the DB', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  const result = await receiver.receive(Buffer.from('not json at all', 'utf8'), RAW_HEADERS, FIXED_NOW);

  expect(result).toEqual({ outcome: 'malformed_body' });
  expect(fake.calls).toHaveLength(0);
});

test('a valid JSON body that is not the batch envelope is a neutral parse error (no DB call)', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  const result = await receiver.receive(
    Buffer.from(JSON.stringify({ token: 'x', data: [] }), 'utf8'),
    RAW_HEADERS,
    FIXED_NOW
  );

  expect(result).toEqual({ outcome: 'malformed_body' });
  expect(fake.calls).toHaveLength(0);
});

test('undecodable gzip (header says gzip but body is not) yields a neutral parse error', async () => {
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  const result = await receiver.receive(Buffer.from('not gzip', 'utf8'), GZIP_HEADERS, FIXED_NOW);

  expect(result).toEqual({ outcome: 'malformed_body' });
  expect(fake.calls).toHaveLength(0);
});

// --- opaque write result ----------------------------------------------------------------

test('treats the DbExecute result as OPAQUE — accepted-count comes from the batch, not returned rows', async () => {
  // The fake returns its default empty result (the non-RETURNING-write contract). The receiver
  // never reads rows off it; accepted reflects the batch size regardless of the (empty) result.
  const fake = createFakeDbExecute();
  const receiver = createReceiver(fake.execute);

  const result = await receiver.receive(
    rawBody(envelope([wireEvent({ uuid: '1' }), wireEvent({ uuid: '2' })])),
    RAW_HEADERS,
    FIXED_NOW
  );

  expect(result).toEqual({ outcome: 'accepted', accepted: 2 });
});
