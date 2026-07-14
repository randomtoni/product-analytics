// The Next.js receiver mounts — thin wrappers over the S1 core for mounting the receiver on a Next
// route. Two shapes cover Next's two routing models:
//
//   - App Router: a route-handler factory `(request) => Promise<Response>` built on the Web
//     `Request`/`Response` globals (NOT a Next import — App-Router route handlers ARE Web handlers;
//     `Request`/`Response` are Node/Web platform globals). The consumer exports the returned handler
//     as the route's `POST`.
//   - Pages API: a `(req, res)` handler over the Node request/response the Pages API exposes
//     (`NextApiRequest extends IncomingMessage`), reading the raw stream.
//
// Next is NEVER imported — this module touches only the request/response SHAPE (Web `Request`/
// `Response`, Node stream) and never Next's runtime value, so importing this module (and the node
// package) pulls NO framework and requires nothing installed. This mirrors `NodeFetch`
// (send-batch.ts) and the pure-structural Express mount. (Next is deliberately NOT an optional
// peer-dep: there is no runtime-value coupling to version-constrain — architect 2026-07-14.)

import type { IncomingMessage, ServerResponse } from 'node:http';
import { translate } from './translate';
import type { Receiver, ReceiverHeaders } from './receiver';

// The minimal App-Router request shape the mount reads: `arrayBuffer()` yields the RAW body bytes
// (possibly gzipped) — the App Router does NOT body-parse, so this is the untouched wire the S1
// core needs for its Content-Encoding check + decompress. Never read `request.json()`: it would
// JSON-parse (and choke on) a gzipped body and break gzip detection. `headers` is the Web
// `Headers`, which the core reads case-insensitively; its `Iterable<[name, value]>` entries satisfy
// the flattening below. A genuine Web `Request` satisfies this structurally.
export interface AppRouterRequestLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  headers: Iterable<[string, string]>;
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 400: 'Bad Request', 500: 'Internal Server Error' };

// Flatten Web `Headers` (an `Iterable<[name, value]>`) into the single-valued case-insensitive bag
// the S1 core takes. Web `Headers` already lowercases names and comma-joins repeats, so a straight
// copy is faithful; the core only reads `Content-Encoding`.
function flattenHeaders(headers: Iterable<[string, string]>): ReceiverHeaders {
  const bag: ReceiverHeaders = {};
  for (const [name, value] of headers) {
    bag[name] = value;
  }
  return bag;
}

// Build a Next App-Router route handler that receives the node batch envelope and writes it via
// `receiver`. The consumer exports the returned function as the route's `POST`:
//
//   export const POST = createNextRouteReceiver(receiver);
//
// It reads the RAW body via `request.arrayBuffer()` + the request headers, calls the S1 core
// through `translate`, and returns a Web `Response` with the neutral status and an empty body — no
// parse, no decompress, no SQL (all in S1). A write failure maps to a neutral 5xx inside
// `translate`; the driver exception never reaches the client.
export function createNextRouteReceiver(
  receiver: Receiver
): (request: AppRouterRequestLike) => Promise<Response> {
  return async (request) => {
    const body = Buffer.from(await request.arrayBuffer());
    const headers = flattenHeaders(request.headers);
    const { status } = await translate(receiver, body, headers);
    return new Response(null, { status, statusText: STATUS_TEXT[status] });
  };
}

// Drain the Pages-API request stream into ONE `Buffer` — the RAW body bytes as they arrived
// (possibly gzipped). The consumer MUST disable Next's automatic body parser for the route
// (`export const config = { api: { bodyParser: false } }`) so the stream carries the untouched
// bytes; the default JSON parser would break gzip detection + the S1 decompress and mis-parse the
// wire. `NextApiRequest extends IncomingMessage`, so this is the identical raw-stream read the
// plain-Node mount does.
function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Build a Next Pages-API `(req, res)` handler that receives the node batch envelope and writes it
// via `receiver`. The consumer disables the Pages-API body parser for the route
// (`config.api.bodyParser = false`) so `req` streams the RAW body. Reads the stream + `req.headers`,
// calls the S1 core through `translate`, and ends the response with the neutral status and an empty
// body — no parse, no decompress, no SQL (all in S1).
export function createNextApiReceiver(
  receiver: Receiver
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const body = await readRawBody(req);
    const { status } = await translate(receiver, body, req.headers);
    res.statusCode = status;
    res.end();
  };
}
