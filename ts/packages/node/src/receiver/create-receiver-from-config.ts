import { createDefaultDbExecute } from '../query/default-db-execute';
import type { ReceiverConfig } from './config';
import { createReceiver } from './receiver';
import type { Receiver } from './receiver';

// The clear neutral error raised when no `warehouseDsn` is configured. A WRITE receiver has NO
// natural empty-success state (unlike the query factory's `QueryNoop`, where an unconfigured read
// returns a well-formed empty result): a consumer who mounts a receiver but supplies no DSN is
// misconfigured, and silently accepting-and-dropping every inbound event would be data loss dressed
// as success. So this factory names the missing field loudly rather than degrading. Transport- and
// vendor-free wording (no HTTP, no driver, no vendor) — mirrors the default-driver's clear-neutral
// error posture, not the query factory's no-op.
const MISSING_WAREHOUSE_DSN =
  'analytics: a receiver requires a warehouseDsn to select the self-host write target; ' +
  'set warehouseDsn on the receiver config or supply your own DbExecute via createReceiver';

// The single ergonomic top-level entry for the write side — the receiver analog of
// `createQueryClient`: a `warehouseDsn` in → a mount-ready `Receiver` out. The WRITE-side twin of
// the query `createWarehouseQueryAdapterFromConfig` (reads the DSN, lazily builds the default
// `DbExecute` from it, injects it), differing only in that this is the consumer's DIRECT entry — so
// it takes the FULL receiver config with the optional `warehouseDsn?` and does the presence check
// itself (there is no receiver equivalent of `createQueryClient` guarding presence ahead of it).
//
// Selection is by field PRESENCE — a `warehouseDsn` supplied ⇒ a DSN-built receiver; absent ⇒ the
// clear neutral error above. No `backend:` enum. The lazy optional-`pg`-peer load lives INSIDE
// `createDefaultDbExecute` (deferred to first exec call), so this factory imports clean and the
// returned `Receiver` CONSTRUCTS without the `warehouse` peer installed — the DSN→driver build is
// an internal detail here, never a DSN or driver handle held on the returned `Receiver`.
//
// The returned `Receiver` is framework-agnostic: the consumer hands it to any S4 mount
// (`createExpressReceiver` / `createNextRouteReceiver` / `createNextApiReceiver` /
// `createReceiverHandler`) — config-only self-host adoption, zero library edit.
export function createReceiverFromConfig(config: ReceiverConfig): Receiver {
  if (config.warehouseDsn === undefined) {
    throw new Error(MISSING_WAREHOUSE_DSN);
  }
  return createReceiver(createDefaultDbExecute({ warehouseDsn: config.warehouseDsn }));
}
