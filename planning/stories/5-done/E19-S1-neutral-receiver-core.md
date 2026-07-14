---
id: E19-S1-neutral-receiver-core
epic: E19-NODE-ingest-receiver-persistence
status: ready-for-dev
area: node
touches: [adapters, capture]
depends_on: []
api_impact: additive
---

# E19-S1-neutral-receiver-core — framework-agnostic receiver: parse the node batch envelope → `events` rows, idempotent upsert on `uuid`

## Why

Self-host has no WRITE path today: capture POSTs the node batch envelope and nothing persists to Neon.
This slice ships the framework-agnostic heart of the receiver — parse the inbound batch envelope the
transport already speaks, and idempotent-upsert each `WireEvent` into the E17 `events` table through the
injected `DbExecute` seam. It goes FIRST: the framework mounts (S2, S4) and the DSN wiring (S3) all wrap
this core.

## Scope

### In

- Ship a **framework-agnostic receiver core** in both trees — a pure function/callable that takes a
  raw request body (`bytes`/`Buffer`) + the request headers and persists the contained events. It
  imports NO web framework. **PINNED module home (architect 2026-07-14):** TS
  `ts/packages/node/src/receiver/` (a new sibling of `query/`); Python
  `python/src/analytics_kit/receiver/` (a new sibling of `server/`). This is the ONE capability's home:
  the S2/S4 framework mounts live INSIDE this same `receiver/` package (as thin edges, mirroring how
  `query/` holds both `db_execute` and `default_db_execute`), NOT in `integrations/`. S3's from-config
  factory also lives here. S2/S3/S4 bind to this path — the home is decided, not a builder pick.
- **Decompress conditionally on the wire.** The transport gzips the body by default and sets
  `Content-Encoding: gzip`, with a raw-JSON fallback that OMITS the header (see `send-batch.ts` /
  `transport.py`). The receiver mirrors that exactly: if `Content-Encoding: gzip` is present,
  gunzip the body; else parse it as raw UTF-8 JSON. Use the stdlib inflate (TS `node:zlib` `gunzipSync`,
  the read-side analog of the send-side `gzipSync` in `gzip.ts`; Python `gzip.decompress`, the analog of
  `transport.py`'s `gzip.compress`). Header lookup is case-insensitive.
- **Parse the node batch envelope** — the EXACT outbound shape, not a new wire and not a PostHog
  `$`-shape:
  - Envelope: `{ api_key, batch: WireEvent[], sent_at }` (confirmed against `assembleBatchEnvelope` /
    `assemble_batch_envelope`).
  - `WireEvent`: `{ uuid, event, distinct_id, properties?, timestamp? }` (`properties`, `timestamp`
    both optional).
  - Read `batch` and upsert each element. `sent_at` is not persisted (batch-transport metadata).
    `api_key` is auth material — NOT persisted, NOT a column (see the auth note in Technical notes).
- **Idempotent upsert on `uuid`** through the injected E17 `DbExecute` seam — the SAME seam the query
  adapter reads through (WRITE path):
  - `INSERT INTO events (distinct_id, event, timestamp, uuid, properties) VALUES (...) ON CONFLICT (uuid)
    DO NOTHING` — one agreed idempotency key (`uuid`, carried verbatim from the neutral `dedupeId`), so a
    client retry / server retry / double-delivery collapses to one stored row.
  - `properties` binds as the **verbatim neutral bag → `jsonb`** (JSON-serialize the bag as the param;
    the driver casts to `jsonb`). Trait/group events already nest `set`/`set_once`/`group_type`/
    `group_key`/`group_set` INSIDE `properties` (node wire-mapper) — persist AS-IS. NO column named after
    those keys (per the E17 schema contract's nesting guard). An absent `properties` binds an empty JSON
    object `{}` (never NULL — the column is `jsonb NOT NULL DEFAULT '{}'` per the shipped E17 DDL, so a
    NULL bind would violate the constraint; bind `{}` explicitly rather than relying on the column
    default).
  - Bind values as **SQL params**, never string-interpolated (mirror E18's `$1`-param posture — no
    injection surface).
- **`timestamp` NOT NULL → the receiver supplies a default when the wire omits it.** The `timestamp`
  column is NOT NULL by contract; the wire field is optional. **DECISION (this story): the default is
  server-receipt time — a single UTC `now` captured ONCE per received batch and applied to every event
  in that batch that omits `timestamp`.** One receipt instant per batch (not per-row) so a batch reads
  as one arrival. When the wire carries `timestamp`, it is used verbatim. Document this in the receiver
  module.
  - **Make the receipt clock testable by the SEND-SIDE parameter pattern, NOT a `wait`-style hook
    (confirmed against the real transport).** The precedent is `assembleBatchEnvelope(apiKey, events,
    now: Date)` / `assemble_batch_envelope(api_key, events, sent_at)` — the PURE mapper takes the
    instant as a PARAMETER; the impure caller (`postEnvelope`/`post_envelope`) supplies the real
    `new Date()` / `datetime.now(timezone.utc)`, and the send-side test (`wire-mapper.test.ts:229`)
    passes a FIXED `now` for a deterministic assertion. `sent_at` is NOT an injected hook (only the
    retry `wait` is). Mirror that here: the pure parse→persist step takes the receipt instant as an
    argument (defaultable to `new Date()` / `datetime.now(timezone.utc)` at the impure boundary), so a
    receipt-time test passes a fixed instant and asserts the exact bound `timestamp` param against the
    fake — no clock-hook machinery. Keep TS/Python parity on this shape.
- **Batch upsert shape.** A batch persists all its events. Whether that is one multi-row `INSERT … ON
  CONFLICT DO NOTHING` or a per-event loop is the builder's pick — but it MUST be assertable against the
  E17 fake `DbExecute` (SQL + params). Prefer one statement per batch (fewer round-trips) if it stays
  cleanly assertable; a per-event loop is acceptable. Pin the choice (record it in the module) so S2/S4
  mounts don't re-decide it. **Intra-batch duplicate `uuid` is SAFE under the multi-row path:** `ON
  CONFLICT … DO NOTHING` does NOT raise on a `uuid` repeated within one statement's VALUES list (the
  "cannot affect row a second time" error is `DO UPDATE`-only) — so the multi-row form needs no
  pre-dedupe pass. Since the seam takes `(sql, params?)`, the multi-row path builds one parameterized
  VALUES list (flattened positional params); the per-event path records N calls — either is directly
  assertable against `RecordedExec`. Whichever is chosen, keep it identical in shape across both trees.
- **Injectable seam — the core holds only the `DbExecute`, never a DSN or driver handle.** The core's
  signature takes an injected `DbExecute` (TS `dbExecute`; Python `db_execute`) exactly as the warehouse
  query adapter does. S3 builds the `DbExecute` from the DSN at the config boundary and hands it in; the
  core never imports `pg`/`psycopg`. This is what makes the core unit-testable against the E17 **reusable
  fake** with NO real Postgres.
- **The write reuses the READ-designed seam — treat the result as OPAQUE (seam-invariant, architect
  2026-07-14).** The `DbExecute` seam (`DbExecuteResult = {rows, columns}`) was designed for E18 READS;
  E19 reuses it for a WRITE. The receiver MUST call `DbExecute` for its `INSERT … ON CONFLICT DO NOTHING`
  and treat the result as opaque — it neither reads rows nor requires a result set. **The seam contract
  is: a non-RETURNING write resolves to an empty `DbExecuteResult` (`{rows: [], columns: []}`).** The E17
  fakes already honor this (default to empty + record SQL+params), so this asserts cleanly against the
  fake with NO real Postgres. The TS default driver already conforms (`pg` returns `rows: []`/`fields: []`
  on a non-RETURNING INSERT). The Python default driver does NOT yet conform (`_result_from_cursor`'s
  unconditional `fetchall()` raises on a write) — that is an E17/E21 driver-conformance follow-up, NOT
  E19 surface (see the Concern flagged to the orchestrator); the receiver core, being fake-backed this
  epic, is unaffected. Do NOT try to make the write path safe against a real driver from inside E19.
- **Return a neutral outcome the mounts translate to an HTTP response.** The core returns a small neutral
  result (e.g. accepted-count, or a neutral error for a malformed body) — NOT an HTTP response object
  (that is the mount's concern, S2/S4). A malformed/undecodable body is a neutral parse error the core
  surfaces; a valid empty `batch` is a no-op success.
- **TS/Python parity:** same envelope parse, same conditional-decompress rule, same upsert SQL shape +
  `ON CONFLICT (uuid) DO NOTHING`, same server-receipt-time default, same neutral outcome. The sync/async
  split matches the existing per-tree `DbExecute` posture (TS `async`/`await this.dbExecute(...)`; Python
  sync `self._db_execute.execute(...)`, plain `def`) — do NOT unify it.

### Out

- Framework-idiomatic mounts (Django / FastAPI / ASGI; Express / Next-route / plain-handler) — **S2**
  (Python) and **S4** (TS). S1 is the framework-agnostic core they wrap.
- Building the `DbExecute` from a `warehouse_dsn` + the receiver config field — **S3** (S1 takes the
  `DbExecute` already constructed; S3 wires DSN → driver → core).
- The `events` schema / DDL / typed view / the `DbExecute` seam + default driver — **E17** (shipped; S1
  WRITES to that schema through that seam, does not own either).
- The warehouse query SQL (READ side) — **E18** (shipped).
- Executing against a real Neon end-to-end — **E21** (S1 asserts SQL + params + idempotency against the
  E17 fake `DbExecute`; no real Postgres).
- Consumer-side request AUTH / api_key verification — out (see the auth note); the core does not enforce
  `api_key`. Enforcement is a consumer-owned mount concern, not this cycle.

## Acceptance criteria

- [ ] A framework-agnostic receiver core exists in both trees (importing no web framework) that takes a
      raw body + headers and persists the contained events through an injected `DbExecute`.
- [ ] The core decompresses conditionally on `Content-Encoding: gzip` (gunzip) vs raw JSON (header
      absent), case-insensitively — mirroring the transport's send-side gzip/raw-fallback.
- [ ] The core parses the EXACT node batch envelope `{ api_key, batch, sent_at }` and each
      `WireEvent { uuid, event, distinct_id, properties?, timestamp? }` — not a new wire, not a `$`-shape.
- [ ] Each event upserts via `INSERT INTO events (distinct_id, event, timestamp, uuid, properties) VALUES
      (...) ON CONFLICT (uuid) DO NOTHING`, values bound as SQL params (never interpolated); asserted
      against the E17 fake `DbExecute` (SQL + params).
- [ ] Idempotency proven: two events sharing a `uuid` produce an `ON CONFLICT (uuid) DO NOTHING` upsert —
      a re-delivered `uuid` does not double-write (asserted against the fake).
- [ ] `properties` binds verbatim as `jsonb` (empty `{}` when absent); trait/group keys stay nested
      inside it with NO column named after `set`/`set_once`/`group_*` (schema-contract nesting guard).
- [ ] A `WireEvent` omitting `timestamp` persists at **server-receipt time** — one UTC instant per
      received batch — satisfying the NOT NULL column; a `WireEvent` carrying `timestamp` uses it
      verbatim.
- [ ] The core holds only the injected `DbExecute` (never a DSN or driver handle); it never imports
      `pg`/`psycopg`. Both neutrality scans green.
- [ ] The write treats the `DbExecute` result as OPAQUE — the receiver never reads rows off the write and
      does not require a result set (the non-RETURNING-write contract: an empty `DbExecuteResult`). The
      E17 fake's default empty result stands in for a real write; the test asserts only recorded
      SQL+params, never a returned row.
- [ ] A malformed/undecodable body yields a neutral parse error (not a raised driver/framework
      exception); a valid empty `batch` is a no-op success. Bar A: no vendor type on the core's surface.
- [ ] TS/Python parity on envelope parse, decompress rule, upsert SQL shape, receipt-time default, and
      neutral outcome; all gates green in both trees; tests run against the E17 fake (no real Postgres).

## Technical notes

**Ground the receiver in the ACTUAL outbound batch envelope — it is the INBOUND counterpart of the
transport.** Read the send side and mirror it exactly; do NOT invent a wire:

- **Envelope (confirmed):** `{ api_key, batch, sent_at }`.
  - TS `assembleBatchEnvelope` (`ts/packages/node/src/wire-mapper.ts:106-116`) → `{ api_key, batch,
    sent_at }`; POSTed (gzipped) by `send-batch.ts:69-83`.
  - Python `assemble_batch_envelope` (`python/src/analytics_kit/server/wire_mapper.py:110-118`) →
    `{ api_key, batch, sent_at }`; POSTed (gzipped) by `server/transport.py:147-154`.
  - **NOT** `{ token, data: [] }` (that is a different/legacy shape — the node envelope uses `api_key` +
    `batch`, verified in both trees). Do not parse a PostHog `$`-prefixed event shape.
- **`WireEvent` (confirmed):** `{ uuid, event, distinct_id, properties?, timestamp? }` —
  `ts/.../wire-mapper.ts:36-42`; the Python wire dict built in `wire_mapper.py:56-79` (same keys;
  `properties`/`timestamp` emitted only when present).
- **Compression (confirmed):** gzip by default, `Content-Encoding: gzip` header set; a null/empty gzip
  result falls back to raw JSON and OMITS the header. Send side: TS `send-batch.ts:69-76` (`gzip()` from
  `gzip.ts`, `gzipSync` with `mtime:0`); Python `transport.py:97-107,147-152` (`gzip.compress(..., mtime=0)`).
  So the receiver: header present ⇒ gunzip (`node:zlib` `gunzipSync` / `gzip.decompress`), header absent
  ⇒ raw UTF-8 JSON. Match the send-side fallback so a raw-JSON POST still parses.

**Column contract is FROZEN (E17 `planning/WAREHOUSE-SCHEMA-CONTRACT.md`) — map `WireEvent` → columns
1:1:**

| Column | Type | From wire field |
|---|---|---|
| `distinct_id` | text NOT NULL | `distinct_id` |
| `event` | text NOT NULL | `event` |
| `timestamp` | timestamptz NOT NULL | `timestamp` — **or server-receipt time when omitted** |
| `uuid` | uuid/text UNIQUE NOT NULL | `uuid` (verbatim from neutral `dedupeId`) |
| `properties` | jsonb | `properties` verbatim (empty `{}` when absent) |

`api_key` and `sent_at` are envelope-level batch metadata, NOT event columns — never persisted.

**Pre-resolved decisions (locked by the epic Notes — do NOT re-litigate):**

- **Idempotency on `uuid` ⇒ `ON CONFLICT (uuid) DO NOTHING`.** `uuid` is the top-level idempotency key
  carried verbatim from the neutral `dedupeId`, so client- and server-side retries dedupe on one agreed
  value against the `events.uuid` UNIQUE constraint (E17 schema). — architect (2026-07-13)
- **Trait/group JSONB guard.** Trait/group events nest `set`/`set_once`/`group_type`/`group_key`/
  `group_set` inside `properties`; persist AS-IS into the `properties` jsonb column, no view/base column
  named after them. Those keys already live inside wire `properties` (node's nesting, not the browser's
  top-level lift), so this is a straight verbatim persist. — architect (2026-07-13)
- **Reuse the existing node batch envelope; do NOT invent a new wire.** `WireEvent { uuid, event,
  distinct_id, properties?, timestamp? }` is the transport↔receiver wire — no PostHog `$`-shape, no new
  canonical wire (YAGNI). The column set IS this envelope's field set — a thin persist over the wire the
  transport already speaks. — architect (2026-07-13)
- **Injectable seam ⇒ no real Postgres this epic.** The core writes through the injected E17 `DbExecute`
  (a fake in unit tests). Do NOT add a blocking `blocked_by`. — architect (2026-07-13)

**Decisions this story fixes (sanctioned by the contract as E19's to fix):**

- **`timestamp`-absent default = server-receipt time.** The schema contract pins the column NOT NULL and
  leaves the default value to E19 ("e.g. server-receipt time"). Fixed here: a single UTC `now` captured
  once per received batch, applied to every wire event in that batch that omits `timestamp`. Rationale:
  well-defined, greenfield (no legacy time to match), one instant per batch reads as one arrival, and it
  keeps query SQL from ever special-casing a null timestamp (the contract's stated goal). — PM
  (2026-07-14)
- **`api_key` is NOT persisted and NOT enforced by the core.** It is auth material, not an event column.
  The core carries it in the parsed envelope but writes no `api_key` column. Request-auth verification
  (does this `api_key` match the consumer's expected key?) is a mount/consumer concern, deliberately out
  of this cycle — the core stays a pure persist. Named so S2/S4 don't wire ad-hoc auth into the core.
  Flag it to the orchestrator if a mount genuinely needs a core auth hook. — PM (2026-07-14)

**Test against the E17 reusable fake — NO real Postgres.** Import: TS `import { createFakeDbExecute }
from '../query/db-execute.fixtures'`; Python `from db_execute_fakes import FakeDbExecute` (in
`python/tests/`). Assert: the upsert SQL string (`INSERT INTO events (...) ... ON CONFLICT (uuid) DO
NOTHING`), the bound params for a batch (distinct_id/event/timestamp/uuid/properties), the receipt-time
default fill (pass a FIXED instant, assert the exact bound `timestamp` param), and idempotency (same
`uuid` → the `DO NOTHING` form; the fake records one call shape). The E17 fake records exec calls
(`RecordedExec`) and returns its default EMPTY `DbExecuteResult` — which IS the write contract (a
non-RETURNING write resolves to `{rows: [], columns: []}`), so the receiver ignores the return and the
test asserts only the recorded SQL+params. Same way E18's SQL-shape tests assert against the fake.

**Reference pointers (read before writing):**
- Outbound wire: `ts/packages/node/src/wire-mapper.ts`, `send-batch.ts`, `gzip.ts`; Python
  `server/wire_mapper.py`, `server/transport.py`.
- Schema contract: `planning/WAREHOUSE-SCHEMA-CONTRACT.md` (columns, NOT NULL timestamp, UNIQUE uuid,
  jsonb properties, nesting guard).
- The `events` table + `DbExecute` seam: `ts/.../query/warehouse-schema.ts` (`EVENTS_TABLE`), `db-execute.ts`,
  `db-execute.fixtures.ts`; Python `query/warehouse_schema.py`, `query/db_execute.py`, `tests/db_execute_fakes.py`.
- The mount pattern the wrappers (S2/S4) will follow: `python/src/analytics_kit/integrations/` (asgi.py,
  django.py, __init__.py lazy re-export).

> Reviewer suggestion (2026-07-14) → E19 improvement pass (doc nudge): `ReceiverHeaders` shape differs
> per tree — TS accepts `string | string[] | undefined` (reads `[0]`), Python types `Mapping[str, str]`
> (single-valued). Defensible per-runtime idiom, but add a one-line Python docstring note that the mount
> must pre-flatten multi-valued headers, so S2/S4 authors know the normalization obligation is asymmetric.
> Reviewer suggestion (2026-07-14) → E21: `isBatchEnvelope` validates only that `batch` is an array;
> per-element `WireEvent` integrity is enforced by the DB constraints (NOT NULL/UNIQUE), not the parser
> (correct for an internal wire, Zod/Pydantic reserved for external boundaries). Forward note: a corrupt
> element (e.g. missing `uuid`) surfaces as a **driver error at execute time, not a neutral
> `malformed_body`** — invisible against the E17 fake, so E21's real-Postgres pass should expect that.

## Shipped

> Captured by `implement-epics` on 2026-07-14.

- **Files added:** `ts/packages/node/src/receiver/` (`receiver.ts`, `index.ts`, `receiver.test.ts`); `python/src/analytics_kit/receiver/` (`receiver.py`, `__init__.py`), `python/tests/test_receiver.py`
- **Files changed:** `ts/packages/node/src/index.ts`, `python/src/analytics_kit/__init__.py` (receiver exports)
- **New public API:** TS `createReceiver(dbExecute) → Receiver` (`Receiver.receive(body, headers, now?) → Promise<ReceiveOutcome>`), `ReceiverHeaders`, `ReceiveOutcome`; Python `Receiver(db_execute)` (`receive(body, headers, now?) → ReceiveOutcome`), `Accepted`/`MalformedBody`. All role-named, zero vendor token
- **Tests added:** 19 per tree — exact upsert SQL/params, injection two-sided proof, multi-row lockstep placeholders, idempotency (`DO NOTHING` + intra-batch dup), properties verbatim jsonb + `{}` default, trait/group nesting (column list = frozen 5), receipt-time (fixed instant, one-per-batch), gzip vs raw decompress (case-insensitive), malformed/non-envelope/undecodable → neutral parse error, empty batch → zero DB calls, opaque write result — all against the E17 fake
- **Commit:** this story's ship commit on `main` (see `git log`)
- **Reviewer notes:** independent gate verdict SHIP (no criticals) — envelope-faithful (reuses the transport's own `WireEvent`/`WireBatchEnvelope` types → symmetric by construction), injection-safe, seam-opaque, byte-identical SQL across trees (reviewer reproduced both builders). 2 doc-nudge suggestions above
- **Cross-story seams exposed:** **S2/S3/S4 bind to `createReceiver(dbExecute) → Receiver`** — the core takes an injected `DbExecute` and holds only it (no DSN/driver/framework). **S3** builds the `DbExecute` from `warehouse_dsn` and composes it onto `createReceiver`; **S2 (Python) + S4 (TS) mounts** translate the neutral `ReceiveOutcome` (`accepted`/`malformed_body`) to an HTTP response and pass raw body + headers in. Single multi-row `INSERT … ON CONFLICT (uuid) DO NOTHING`; receipt instant is the `now?` param. **E21:** the known Python-driver `fetchall()` write-raise (deferred) must be fixed before the real receiver writes to Neon.
