// The shared, framework-free response mapping — the ONE neutral-outcome→HTTP-status mapping every
// TS mount (plain-handler / Express / Next-route) calls, so they map IDENTICALLY (capability
// parity). This is the TS analog of the Python `receiver/mount.py::translate` helper: the mounts'
// only real work is (1) read the framework request's RAW body + headers and (2) translate the
// neutral outcome to their framework's response — this module owns (2), holding ZERO framework
// types so a single mapping is shared across every mount.

import type { Receiver, ReceiverHeaders } from './receiver';

// The neutral HTTP status classes the mounts respond with. `accepted` → 2xx, `malformed_body` →
// 4xx, and a thrown write (the injected `DbExecute` rejecting — a driver / DB failure the seam
// surfaces raw) → a neutral 5xx. No body is carried: a human-readable reason is a logging concern,
// never part of the response (the response carries zero vendor/driver vocabulary).
export const STATUS_ACCEPTED = 200;
export const STATUS_MALFORMED_BODY = 400;
export const STATUS_WRITE_FAILED = 500;

// Run the receive and map the neutral outcome to a bare `{ status }`. A thrown write is CAUGHT
// here — scoped to exactly the `receive` call — and mapped to a neutral 5xx so the driver/framework
// exception NEVER reaches the client (a DB outage is not a client parse error, and its message may
// carry connection detail). The `switch` is exhaustive over the `ReceiveOutcome` union: a `never`
// default makes the typechecker flag a missing arm if the core ever grows a third outcome, so a new
// outcome must get a deliberate status rather than silently defaulting.
export async function translate(
  receiver: Receiver,
  body: Buffer,
  headers: ReceiverHeaders
): Promise<{ status: number }> {
  let outcome;
  try {
    outcome = await receiver.receive(body, headers);
  } catch {
    return { status: STATUS_WRITE_FAILED };
  }
  switch (outcome.outcome) {
    case 'accepted':
      return { status: STATUS_ACCEPTED };
    case 'malformed_body':
      return { status: STATUS_MALFORMED_BODY };
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
