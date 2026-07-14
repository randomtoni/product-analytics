import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { expect, test, vi } from 'vitest';
import { createFakeDbExecute } from '../query/db-execute.fixtures';
import type { WireBatchEnvelope, WireEvent } from '../wire-mapper';
import { createReceiver, type Receiver, type ReceiverHeaders } from './receiver';
import {
  createNextRouteReceiver,
  createNextApiReceiver,
  type AppRouterRequestLike,
} from './next-mount';

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

// A fake App-Router request: a Web `Request` carrying the raw body + a `content-encoding` header.
// The real Web `Request` global (available via @types/node) is used so `arrayBuffer()` + `headers`
// behave exactly as in a Next App-Router route handler.
function appRouterRequest(body: Buffer, gzip: boolean): AppRouterRequestLike {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (gzip) headers['content-encoding'] = 'gzip';
  return new Request('http://localhost/ingest', {
    method: 'POST',
    headers,
    body: new Uint8Array(body),
  }) as unknown as AppRouterRequestLike;
}

const RAW_HEADERS: ReceiverHeaders = { 'content-type': 'application/json' };
const GZIP_HEADERS: ReceiverHeaders = {
  'content-type': 'application/json',
  'content-encoding': 'gzip',
};

// --- App-Router route handler (Request → Response) --------------------------------------

test('App-Router: reads the raw body via arrayBuffer and returns a 200 Response on accept', async () => {
  const fake = createFakeDbExecute();
  const handler = createNextRouteReceiver(createReceiver(fake.execute));

  const response = await handler(appRouterRequest(rawBody(envelope([wireEvent()])), false));

  expect(response.status).toBe(200);
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].params?.[3]).toBe('dd-1');
});

test('App-Router: a GZIPPED raw body reaches the core (gzip detection survives arrayBuffer)', async () => {
  const fake = createFakeDbExecute();
  const handler = createNextRouteReceiver(createReceiver(fake.execute));

  const response = await handler(appRouterRequest(gzipBody(envelope([wireEvent()])), true));

  expect(response.status).toBe(200);
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].params?.[3]).toBe('dd-1');
});

test('App-Router: passes the raw body + a flattened case-insensitive header bag to the core', async () => {
  const receive = vi.fn().mockResolvedValue({ outcome: 'accepted', accepted: 1 });
  const handler = createNextRouteReceiver({ receive } satisfies Receiver);
  const body = gzipBody(envelope([wireEvent()]));

  await handler(appRouterRequest(body, true));

  const [passedBody, passedHeaders] = receive.mock.calls[0];
  expect(Buffer.isBuffer(passedBody)).toBe(true);
  expect(passedBody.equals(body)).toBe(true);
  // Web `Headers` lowercases names; the flattened bag carries content-encoding for the core.
  expect(passedHeaders['content-encoding']).toBe('gzip');
});

test('App-Router: a malformed body maps to a 400 Response and never calls the DB', async () => {
  const fake = createFakeDbExecute();
  const handler = createNextRouteReceiver(createReceiver(fake.execute));

  const response = await handler(appRouterRequest(Buffer.from('not json', 'utf8'), false));

  expect(response.status).toBe(400);
  expect(fake.calls).toHaveLength(0);
});

test('App-Router: a DB write failure maps to a neutral 500 Response and leaks no driver message', async () => {
  const driverError = new Error('pg: FATAL password authentication failed for user "app" at 10.0.0.5');
  const handler = createNextRouteReceiver({ receive: () => Promise.reject(driverError) });

  const response = await handler(appRouterRequest(rawBody(envelope([wireEvent()])), false));

  expect(response.status).toBe(500);
  expect(await response.text()).toBe('');
});

// --- Pages-API handler (req, res) -------------------------------------------------------

function pagesApiRequest(body: Buffer, headers: ReceiverHeaders): IncomingMessage {
  const req = Readable.from([body]) as unknown as IncomingMessage;
  req.headers = headers;
  return req;
}

function pagesApiResponse(): ServerResponse & { ended: boolean } {
  const res = {
    statusCode: 0,
    ended: false,
    end() {
      this.ended = true;
    },
  };
  return res as unknown as ServerResponse & { ended: boolean };
}

test('Pages-API: reads the raw stream + headers and writes 200 on accept', async () => {
  const fake = createFakeDbExecute();
  const handler = createNextApiReceiver(createReceiver(fake.execute));
  const res = pagesApiResponse();

  await handler(pagesApiRequest(rawBody(envelope([wireEvent()])), RAW_HEADERS), res);

  expect(res.statusCode).toBe(200);
  expect(res.ended).toBe(true);
  expect(fake.calls[0].params?.[3]).toBe('dd-1');
});

test('Pages-API: a GZIPPED raw stream reaches the core and upserts', async () => {
  const fake = createFakeDbExecute();
  const handler = createNextApiReceiver(createReceiver(fake.execute));
  const res = pagesApiResponse();

  await handler(pagesApiRequest(gzipBody(envelope([wireEvent()])), GZIP_HEADERS), res);

  expect(res.statusCode).toBe(200);
  expect(fake.calls[0].params?.[3]).toBe('dd-1');
});

test('Pages-API: a DB write failure maps to a neutral 500 and leaks no driver message', async () => {
  const handler = createNextApiReceiver({
    receive: () => Promise.reject(new Error('connection refused 10.0.0.5:5432')),
  });
  const res = pagesApiResponse();

  await handler(pagesApiRequest(rawBody(envelope([wireEvent()])), RAW_HEADERS), res);

  expect(res.statusCode).toBe(500);
});
