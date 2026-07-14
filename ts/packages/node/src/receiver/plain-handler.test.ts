import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { expect, test, vi } from 'vitest';
import { createFakeDbExecute } from '../query/db-execute.fixtures';
import type { WireBatchEnvelope, WireEvent } from '../wire-mapper';
import { createReceiver, type Receiver, type ReceiverHeaders } from './receiver';
import { createReceiverHandler } from './plain-handler';

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

// A fake IncomingMessage: a Readable carrying the RAW body bytes + the headers bag, so the handler
// drains the exact wire bytes (no framework body-parse in front of it).
function fakeRequest(body: Buffer, headers: ReceiverHeaders): IncomingMessage {
  const req = Readable.from([body]) as unknown as IncomingMessage;
  req.headers = headers;
  return req;
}

function fakeResponse(): ServerResponse & { ended: boolean } {
  const res = {
    statusCode: 0,
    ended: false,
    end() {
      this.ended = true;
    },
  };
  return res as unknown as ServerResponse & { ended: boolean };
}

const RAW_HEADERS: ReceiverHeaders = { 'content-type': 'application/json' };
const GZIP_HEADERS: ReceiverHeaders = {
  'content-type': 'application/json',
  'content-encoding': 'gzip',
};

test('reads the raw body + headers and writes 200 on an accepted envelope', async () => {
  const fake = createFakeDbExecute();
  const handler = createReceiverHandler(createReceiver(fake.execute));
  const res = fakeResponse();

  await handler(fakeRequest(rawBody(envelope([wireEvent()])), RAW_HEADERS), res);

  expect(res.statusCode).toBe(200);
  expect(res.ended).toBe(true);
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].params?.[3]).toBe('dd-1');
});

test('a GZIPPED raw body reaches the core and upserts (gzip detection survives the mount)', async () => {
  const fake = createFakeDbExecute();
  const handler = createReceiverHandler(createReceiver(fake.execute));
  const res = fakeResponse();

  await handler(fakeRequest(gzipBody(envelope([wireEvent()])), GZIP_HEADERS), res);

  expect(res.statusCode).toBe(200);
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].params?.[3]).toBe('dd-1');
});

test('passes the raw body + headers verbatim to the S1 core (thin wrapper, no parse/decompress)', async () => {
  const receive = vi.fn().mockResolvedValue({ outcome: 'accepted', accepted: 1 });
  const receiver: Receiver = { receive };
  const handler = createReceiverHandler(receiver);
  const body = gzipBody(envelope([wireEvent()]));

  await handler(fakeRequest(body, GZIP_HEADERS), fakeResponse());

  expect(receive).toHaveBeenCalledTimes(1);
  const [passedBody, passedHeaders] = receive.mock.calls[0];
  expect(Buffer.isBuffer(passedBody)).toBe(true);
  expect(passedBody.equals(body)).toBe(true);
  expect(passedHeaders).toEqual(GZIP_HEADERS);
});

test('a malformed body maps to 400 and never calls the DB', async () => {
  const fake = createFakeDbExecute();
  const handler = createReceiverHandler(createReceiver(fake.execute));
  const res = fakeResponse();

  await handler(fakeRequest(Buffer.from('not json', 'utf8'), RAW_HEADERS), res);

  expect(res.statusCode).toBe(400);
  expect(fake.calls).toHaveLength(0);
});

test('a DB write failure maps to a neutral 500 and leaks no driver message', async () => {
  const driverError = new Error('connection to 10.0.0.5:5432 refused: password authentication failed');
  const receiver: Receiver = {
    receive: () => Promise.reject(driverError),
  };
  const handler = createReceiverHandler(receiver);
  const res = fakeResponse();

  await handler(fakeRequest(rawBody(envelope([wireEvent()])), RAW_HEADERS), res);

  expect(res.statusCode).toBe(500);
  expect(res.ended).toBe(true);
});
