// The Express receiver mount — a thin `(req, res) => ...` handler over the S1 core, for mounting
// the receiver on an Express route.
//
// Express is typed PURELY STRUCTURALLY (the `ExpressRequestLike`/`ExpressResponseLike` shapes
// below) and is NEVER imported — this module touches only the request/response SHAPE, never
// Express's runtime value. So importing this module (and the node package) pulls NO framework and
// requires NOTHING installed; a genuine Express `req`/`res` satisfies the shapes structurally. This
// mirrors `NodeFetch` (send-batch.ts) and `ReceiverHeaders` (receiver.ts), which re-declare minimal
// contracts rather than importing the ambient type. (Express is deliberately NOT an optional
// peer-dep: there is no runtime-value coupling to version-constrain — architect 2026-07-14.)

import { translate } from './translate';
import type { Receiver, ReceiverHeaders } from './receiver';

// The minimal Express request shape the mount reads: the header bag (already the case-insensitive,
// single-or-multi-valued shape `ReceiverHeaders` mirrors) and the RAW body Buffer. The consumer
// MUST install a raw-body middleware (`express.raw({ type: '*/*' })`) — NOT `express.json()` — so
// `req.body` is the untouched bytes (possibly gzipped) the S1 core's Content-Encoding check +
// decompress needs. `express.json()` would JSON-parse (and choke on) a gzipped body and break gzip
// detection — the single most likely mount bug. See the mount factory doc below.
export interface ExpressRequestLike {
  headers: ReceiverHeaders;
  body: Buffer;
}

// The minimal Express response shape the mount writes: `status(n)` to set the code (chainable, the
// Express convention) and `end()` to finish with an empty body (the neutral response carries no
// vendor/driver vocabulary). A genuine Express `Response` satisfies this structurally.
export interface ExpressResponseLike {
  status(code: number): ExpressResponseLike;
  end(): void;
}

// Build an Express handler that receives the node batch envelope and writes it via `receiver`.
//
// The consumer MUST feed this handler the RAW body — mount `express.raw({ type: '*/*' })` on the
// route (or a router-level raw-body middleware) so `req.body` is the untouched Buffer. Do NOT use
// `express.json()`: it JSON-parses the body, which breaks the S1 gzip detection + decompress and
// mis-parses the wire.
//
// The handler reads `req.body` + `req.headers`, calls the S1 core through `translate`, and responds
// with the neutral status and an empty body — no parse, no decompress, no SQL (all in S1). A write
// failure (the injected `DbExecute` rejecting) maps to a neutral 5xx inside `translate`; the driver
// exception never reaches the client.
export function createExpressReceiver(
  receiver: Receiver
): (req: ExpressRequestLike, res: ExpressResponseLike) => Promise<void> {
  return async (req, res) => {
    const { status } = await translate(receiver, req.body, req.headers);
    res.status(status).end();
  };
}
