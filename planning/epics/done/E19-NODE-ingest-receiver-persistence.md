---
id: E19-NODE-ingest-receiver-persistence
status: done
area: node
touches: [node, adapters, capture]
api_impact: additive
blocked_by: []
updated: 2026-07-14
---

# E19-NODE-ingest-receiver-persistence — Ingest receiver + Neon persistence: mountable reference receiver writing the events table

## Why

Self-host has no WRITE path today: capture speaks PostHog ingest (`/batch/`) and nothing persists to
Neon. To make the full loop (capture → store → query) run against a consumer's own Postgres with ZERO
consumer code change, the LIBRARY must ship a **framework-mountable reference receiver** — the inbound
analog of the existing request-context middlewares — that parses the node batch envelope and writes
rows into the library-owned `events` table (E17). The consumer provisions Neon, runs the migration, and
mounts the handler; they write no server component. This is the closing half of the acceptance bar's
data loop.

## Success criteria

- The LIBRARY ships a **framework-mountable reference receiver** whose neutral core parses the node
  batch envelope → `events` rows and performs an **idempotent upsert on `uuid`** into the E17 `events`
  table via the injected DB-execute seam. The consumer mounts it; the consumer writes no server logic.
- The transport↔receiver wire **REUSES the existing (already-neutral) node batch envelope** —
  `WireEvent { uuid, event, distinct_id, properties?, timestamp? }`
  (`ts/packages/node/src/wire-mapper.ts`). No new canonical wire is invented; no PostHog `$`-shape is
  copied.
- **Framework mounts** are shipped as the inbound analog of the existing middlewares: Python
  Django + FastAPI/ASGI; TS Express / Next-route / plain-handler. The framework SET differs by
  ecosystem; **capability is at parity**.
- Receiver-side config selects the write target by the **same warehouse-DSN field shape** as the query
  config (C symmetry) — one coherent "here's my Neon" across read and write.
- **Trait/group guard:** trait/group events nest de-branded `set`/`set_once`/`group_*` inside
  `properties`; the receiver persists them **as-is into the `properties` JSONB column**, with no view
  column named after them (per the E17 schema contract).
- **Bar A:** swapping to self-host is one adapter/receiver, ZERO consumer code change vs the PostHog
  config (same taxonomy, identity, allowlist, events). **Bar B:** a consumer adopts by config +
  mounting the shipped handler — no library edit.
- TS/Python receiver parity (capability, not framework-for-framework). All gates green in both trees +
  both neutrality scans. Buildable/testable against the injected fake DB-execute seam — no real
  Postgres needed for this epic.

## Stories

- **[E19-S1](../stories/5-done/E19-S1-neutral-receiver-core.md)** *(done — `2b93e35`)* —
  framework-agnostic receiver core: conditional-decompress + parse the node batch envelope
  `{ api_key, batch, sent_at }` → `WireEvent`s → idempotent `INSERT … ON CONFLICT (uuid) DO NOTHING`
  via the injected E17 `DbExecute` (reuses its OWN transport `WireEvent`/`WireBatchEnvelope` types →
  symmetric with the transport by construction); trait/group props verbatim into `properties` jsonb;
  receipt-time default (one UTC instant per batch).
- **[E19-S2](../stories/5-done/E19-S2-python-framework-mounts.md)** *(done — `2e8c923`)*
  — Python Django + FastAPI/ASGI receiver mounts, thin wrappers over the S1 core, replicating (not
  importing) the request-context middleware convention (lazy-import, extra-gated, `__getattr__`;
  subprocess-proven framework-free bare import).
- **[E19-S3](../stories/5-done/E19-S3-receiver-warehouse-dsn-selection.md)** *(done — `b64e43f`)* —
  receiver `warehouse_dsn` config (same field SHAPE as the query config; C symmetry) + from-config
  factory that builds the `DbExecute` at the boundary and injects it (E17-S4's factory-builds-driver
  pattern; core/mounts stay DSN-free); absent-DSN → **clear neutral error, no silent drop**.
- **[E19-S4](../stories/5-done/E19-S4-ts-receiver-parity.md)** *(done — `02e5da1`)* — TS
  receiver mounts (Express / Next-route / plain-handler) over the same S1 core; **pure-structural typing,
  no framework import, no peer-dep** (endorsed — the mounts touch shapes not values); raw-body + gzip
  survival verified per mount.

**Dependency graph:** `S1 → (S2 ∥ S3 ∥ S4)`. S1 (the neutral core) lands first; S2 (Python mounts),
S3 (config/DSN wiring), S4 (TS mounts) each `depends_on` S1. **Serial ordering for overlapping files:**
S3's from-config factory wraps the S2 (Python) and S4 (TS) mounts and touches the same receiver-package
`__init__`/exports, so run **S2 → S3** in the Python tree and **S4 → S3** (or coordinated) in the TS
tree; S2 and S4 are in different trees and can run independently after S1.

## Out of scope

- The events schema, typed view, DB-execute seam, and migration — **E17** (this epic WRITES to that
  schema; it does not own it).
- The warehouse query SQL — **E18** (this epic is the WRITE side; E18 is the READ side).
- Fully-local flags — **E20**.
- The end-to-end zero-egress acceptance test against a real Postgres — **E21**.
- A **consumer-built receiver** or handing the consumer the raw `$`/`data:[]` payload — REJECTED (see
  Notes A); both force the consumer to write a server component, breaking bar A.
- Inventing a **new canonical wire** between transport and receiver — REJECTED (YAGNI); reuse the
  existing node batch envelope.
- Data backfill from an existing PostHog deployment — not applicable (greenfield consumer).

## Notes

Locked by architect consult (2026-07-13) — do not re-litigate in stories.

- **A — the LIBRARY ships the receiver; the CONSUMER mounts it.** The library ships a
  framework-mountable reference receiver and OWNS the `events` table schema + typed view + migration
  (in E17); the consumer provisions Neon + runs the migration + mounts the handler. REJECTED: a
  consumer-built receiver / handing the consumer the raw `$`/`data:[]` payload — both force the
  consumer to write a server component, breaking "provider-swap = zero consumer change." The receiver
  is the **INBOUND analog of the existing `integrations/` middlewares** (Django/ASGI,
  `python/src/analytics_kit/integrations/`). — architect (2026-07-13)
- **A — reuse the existing node batch envelope; do NOT invent a new wire.** The transport↔receiver
  wire REUSES the existing (already-neutral) node batch envelope —
  `WireEvent { uuid, event, distinct_id, properties?, timestamp? }`
  (`ts/packages/node/src/wire-mapper.ts` shape). Do NOT invent a new canonical wire (YAGNI); do NOT
  copy PostHog's `$`-shape. The library owns the schema (E17) because receiver-writes and query-reads
  (E18) must agree on ONE column contract (`distinct_id`, `event`, `timestamp`, `uuid` unique,
  `properties` jsonb) — which is exactly the envelope's field set. — architect (2026-07-13)
- **A — the trait/group JSONB guard.** Trait/group events nest de-branded
  `set`/`set_once`/`group_type`/`group_key`/`group_set` inside `properties`; the receiver persists them
  **as-is into JSONB**, no view column named after them. (Consistent with the wire-mapper's node
  nesting — those keys already live inside wire `properties`, not top-level.) — architect (2026-07-13)
- **A — idempotency on `uuid`.** `uuid` is the top-level idempotency key carried verbatim from the
  neutral `dedupeId` (per the wire-mapper), so client- and server-side retries dedupe on one agreed
  value. The receiver upserts on the `events.uuid` UNIQUE constraint (E17 schema). — architect
  (2026-07-13)
- **C symmetry — same warehouse-DSN field shape as query config.** Receiver-side selection uses the
  SAME warehouse-DSN field SHAPE as the query config (E17), so self-host is one coherent "here's my
  Neon" across read and write. — architect (2026-07-13)
- **Framework set differs by ecosystem; capability at parity.** Python mounts = Django + FastAPI/ASGI
  (mirroring the existing middleware set). TS mounts = Express / Next-route / plain-handler. The
  framework SET differs by ecosystem — capability is at parity, not framework-for-framework. Medium
  risk lives in the TS mount surface. — architect (2026-07-13)
- **Injectable seam — no real Postgres for this epic.** The receiver writes through the E17 injectable
  DB-execute seam (a fake in unit tests). The receiver is buildable/testable WITHOUT a real Neon; only
  the E21 end-to-end test needs a real/local Postgres. Do NOT set a blocking `blocked_by`. — architect
  (2026-07-13)

## Expansion path

Additional framework mounts (new web frameworks in either ecosystem) are additive wrappers over the
same neutral receiver core — zero change to the core or the schema. A future non-Neon Postgres write
target is the same receiver over a different DB-execute driver behind the E17 seam. Batching/backpressure
tuning on the receiver is an additive follow-up, not required for the acceptance bar.
