// The framework-free receiver mount — the base every other TS mount reduces to (the TS analog of
// the Python framework-free ASGI receiver). A handler over the standard Node
// `IncomingMessage`/`ServerResponse` that reads the RAW request body + headers, calls the S1 core
// through the shared `translate`, and writes the response. Imports NO web framework — a bare
// `import` of this module pulls only `node:http` types, so the node package imports clean with no
// consumer framework installed.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { translate } from './translate';
import type { Receiver } from './receiver';

// Drain the request stream into ONE `Buffer` — the RAW body bytes exactly as they arrived on the
// wire (possibly gzipped). This is the single most important mount contract: a Node HTTP server
// does NOT body-parse by default, so reading the stream here yields the untouched bytes the S1 core
// needs for its Content-Encoding gzip check + decompress. Do NOT put a JSON body-parser in front of
// this handler — a parsed body would break gzip detection and mis-parse the wire.
function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// A framework-free `(req, res)` handler that receives the node batch envelope and writes it via
// `receiver`. Reads the raw body + `req.headers` (already the case-insensitive, single-or-multi
// valued `IncomingHttpHeaders` bag the core's `ReceiverHeaders` mirrors structurally), calls the S1
// core through `translate`, and ends the response with the neutral status and an empty body. The
// mount decides nothing about the wire — no parse, no decompress, no SQL (all in S1).
export function createReceiverHandler(
  receiver: Receiver
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const body = await readRawBody(req);
    const { status } = await translate(receiver, body, req.headers);
    res.statusCode = status;
    res.end();
  };
}
