---
id: E18-S1-trend-unique-count-sql
epic: E18-QRY-warehouse-query-primitives
status: ready-for-dev
area: query
touches: [adapters, node]
depends_on: []
api_impact: additive
---

# E18-S1-trend-unique-count-sql — `trend` + `unique_count` as SQL over the typed view; the SQL-gen module + flat-row-builder pattern

## Why

`trend`/`unique_count` are the easy pair (date_trunc bucket + count), but they go FIRST because this
slice establishes the two reusable pieces every downstream E18 story binds to: the **SQL-generation
module** (co-located with the warehouse adapter, targeting `EVENTS_VIEW` columns) and the
**flat-row-builder pattern** (flatten a positional `DbExecuteResult` into neutral rows, then hand to a
shared `normalizeResult`-shaped assembler that stamps `columns`/`generatedAt`). Land the pattern here
so S2/S3/S4 fill in per-primitive builders, not scaffolding.

## Scope

### In

- Fill the `trend` and `uniqueCount`/`unique_count` bodies of `WarehouseQueryAdapter` in both trees so
  they COMPUTE (no more not-implemented throw), routing SQL through the injected DB-execute seam
  (`this.dbExecute` TS / `self._db_execute` Python — already on the constructed adapter from E17-S4).
- Establish the **SQL-generation module** — a new co-located module (TS `ts/packages/node/src/query/`,
  Python `python/src/analytics_kit/query/`; pick a role-named file, e.g. `warehouse-sql.ts` /
  `warehouse_sql.py`, unless the builder finds a better-fitting home) holding pure SQL-builder
  functions that emit Postgres SQL over `EVENTS_VIEW` (from E17-S2's `warehouse-schema`), never
  `properties` directly and never the base `events` table. The trend/unique_count builder is the first
  resident; funnel/retention/raw builders (S2–S4) join it.
- **The shared trend walk** (`trend` and `unique_count` share it — `UniqueCountRow` IS `TrendRow`):
  - `date_trunc(<bucket-unit>, timestamp)` bucket over `spec.window` (a `Duration` — derive the
    `date_trunc` unit + the window lower bound from `window.unit`/`window.value`).
  - `count(*)` for `aggregation: 'total'`; `count(distinct distinct_id)` for `'unique'`/`'dau'`
    (trend) and for `unique_count` (which is always distinct actors — see the E17-S2 adapter-stub
    mapping and the `Aggregation` type in `query-client.ts:17`).
  - Restrict to `spec.event` (`WHERE event = <name>`).
  - `breakdown` when present: `GROUP BY (properties->>'<breakdown>')` **against the JSONB path**
    (breakdown is a runtime `string`, not a typed view column, so it reads `properties->>` directly —
    the ONE place trend/unique_count touch `properties`; the bucketed columns come from the view). The
    breakdown value is stringified onto every neutral row.
  - **Empty buckets zero-filled** via `generate_series` over the window at the bucket interval, LEFT
    JOINed to the counts so a bucket with no events yields `value: 0`, never a gap.
- **The flat-row builder + shared assembler pattern (the load-bearing deliverable):**
  - Write a per-primitive **flat-row builder** that flattens `DbExecuteResult.rows` (positional cells,
    keyed by the SELECT's column ORDER) into `TrendRow[]` (`{ bucket, value, breakdown? }`). Read cells
    positionally (or zip to names once via the existing `zipRow`/`_zip_row` helper) — do NOT read
    engine-nested `days`/`data` (that is the HTTP builder's shape; see the CRITICAL note below).
  - Write a **shared assembler** — a warehouse analog of the HTTP adapter's `normalizeResult`
    (`http-query-adapter.ts:221`) — that takes a `DbExecuteResult` + a flat-row builder and produces a
    `QueryResult<TRow>`: stamps `columns` (from `DbExecuteResult.columns` → neutral
    `QueryColumn{name,type?}`), `generatedAt: new Date().toISOString()` / `datetime.now(...).isoformat()`,
    and no `fromCache` (a live SQL exec has no cache flag — omit it, do not fabricate one). This
    assembler is what S2–S4 reuse; only the per-primitive flat-row builder changes.
- **TS/Python parity:** same SQL shape, same bucket/count/zero-fill rule, same flat-row-builder +
  assembler split, same neutral rows. The generated SQL is Postgres and identical across trees; assert
  the SQL shape in both trees' unit tests against the E17-S3 **reusable fake `DbExecute`** (canned
  `DbExecuteResult`s in → asserted neutral rows out) — no real Postgres.

### Out

- `funnel` — **S2**. `retention` — **S3**. `raw_query` + the dialect-split doc — **S4**. The row-parity
  proof against `query-contract.fixtures` — **S5**.
- Any change to the DB-execute seam, the config, the factory, or the typed-view generator — **E17**
  (shipped; this story consumes them read-only).
- Executing against a real Neon — **E21** (S1 asserts SQL shape + row flattening against canned
  `DbExecuteResult`s via the fake).
- Growing the neutral query surface beyond the existing spec/row types — out (rows are LOCKED by
  `QUERY-ROW-CONTRACT.md`).

## Acceptance criteria

- [ ] `trend` and `uniqueCount`/`unique_count` COMPUTE in both trees — no not-implemented throw —
      routing SQL through the injected `DbExecute` seam and returning `QueryResult<TrendRow>` /
      `QueryResult<UniqueCountRow>`.
- [ ] The generated SQL buckets via `date_trunc` over `spec.window`, counts with `count(*)` (total) vs
      `count(distinct distinct_id)` (unique/dau + unique_count), filters to `spec.event`, and
      zero-fills empty buckets via `generate_series` — asserted by unit test on the SQL string.
- [ ] With `spec.breakdown` present, the SQL `GROUP BY (properties->>'<breakdown>')` and the neutral
      rows carry the stringified `breakdown`; without it, rows omit `breakdown`.
- [ ] A per-primitive **flat-row builder** flattens positional `DbExecuteResult.rows` into `TrendRow`s,
      and a **shared assembler** (warehouse analog of `normalizeResult`) stamps `columns`/`generatedAt`
      and omits `fromCache` — both live in the new SQL-gen/adapter modules and are reused by S2–S4.
- [ ] Neutral rows match the `TrendRow` contract exactly (`{ bucket, value, breakdown? }`); no SQL
      column name or engine token leaks onto a row.
- [ ] TS/Python parity on SQL shape, the builder/assembler split, and rows; both trees' tests run
      against the E17-S3 fake `DbExecute` (no real Postgres); both neutrality scans green; all gates
      green in both trees.

## Technical notes

Binds to E17: the typed view is `EVENTS_VIEW` over `EVENTS_TABLE` (`warehouse-schema.ts` /
`warehouse_schema.py`; base cols `distinct_id, event, timestamp, uuid` + safe-cast event-prop
projections). Route SQL through the injected seam; the adapter already holds it (`this.dbExecute` /
`self._db_execute`, added by E17-S4). Rows are LOCKED by `planning/QUERY-ROW-CONTRACT.md` +
`query-contract.fixtures` — this story produces `TrendRow`s FROM SQL, it does not re-decide the shape.

**Pre-resolved decisions (locked by the epic Notes + E17-S3's architect review — do NOT re-litigate):**

- **CRITICAL — E18 writes its OWN flat-row builders; do NOT reuse the HTTP adapter's nested builders
  (architect, E17-S3 review 2026-07-14).** The epic Notes' "reuse the existing row-builders" is REFINED
  by E17-S3: the HTTP adapter's `buildTrendRows` (`http-query-adapter.ts:268`) reads engine-shaped
  NESTED objects — parallel `days[]`/`data[]` arrays out of `results`. Warehouse SQL yields **FLAT
  tabular rows** (`DbExecuteResult.rows` = positional cells). So E18 writes its own flat-row builders
  that flatten the SQL result into the SAME neutral row TYPES (`TrendRow`/`UniqueCountRow` from
  `@randomtoni/analytics-kit`), reusing the row TYPES + the normalizer PATTERN — NOT literally calling
  `buildTrendRows`. "Byte-identical by construction" = identical row types + identical field values,
  proven against `query-contract.fixtures` in S5 — NOT force-reusing the nested HTTP builder.
- **What TO reuse from the HTTP adapter:** the `normalizeResult` PATTERN (raw payload → per-primitive
  builder → `QueryResult` with stamped `columns`/`generatedAt`, `http-query-adapter.ts:221-246`) and,
  for S4's raw path, the `zipRow`/`_zip_row` helper (`http-query-adapter.ts:395`) — the columns-present
  positional-cell zip. Both already match the `DbExecuteResult` positional shape (that is why E17-S3
  pinned rows-as-arrays-of-arrays). Write the warehouse assembler as a sibling analog, not by importing
  the HTTP one (its input type is `WireResultBearing`, HTTP-shaped).
- **Semantics are documented divergence, NOT byte-exact HogQL parity (user decision).** The consumer is
  greenfield — no PostHog data to match, no posthog-source-guide-vs-server-repo dependency. Trend has no
  contested convention (bucket + count is unambiguous); still, document the chosen `date_trunc` unit
  derivation from `Duration.unit`.
- **The adapter fills its stub method bodies against the injected seam — no seam/factory change.** E17-S4
  already made the adapter constructable with an injected `DbExecute` and selectable; S1 only fills the
  `trend`/`unique_count` bodies. The DSN→driver build stays at the `createWarehouseQueryAdapterFromConfig`
  boundary; the adapter never sees a DSN/handle.
- **Buildable/testable against the E17-S3 reusable fake — NO real Postgres.** Import: TS
  `import { createFakeDbExecute } from '../query/db-execute.fixtures'`; Python
  `from db_execute_fakes import FakeDbExecute` (in `python/tests/`). Assert the generated SQL string
  shape + the flat-row→neutral-row flattening against canned `DbExecuteResult`s.
- **Postgres ≥16** for the generated view (E17-S2, `pg_input_is_valid` safe-cast) — a query-TIME note
  only, not a build blocker; S1 tests against the fake and never runs real SQL.

**Reference pointers (read before writing):**
- Neutral rows: `ts/packages/analytics-kit/src/query-result.ts` (`TrendRow`/`UniqueCountRow` =
  `{ bucket, value, breakdown? }`; `UniqueCountRow` is a type alias of `TrendRow`).
- Specs: `ts/packages/node/src/query/query-client.ts:33-43` (`TrendSpec`: `event`/`aggregation`/`window`/
  `breakdown?`; `UniqueCountSpec`: `event`/`window`/`breakdown?`; `Duration` = `{ value, unit }`,
  `Aggregation` = `'total'|'unique'|'dau'`). Python mirror in `python/src/analytics_kit/query/client.py`.
- Typed view + base cols: E17-S2 `EVENTS_VIEW`/`EVENTS_TABLE` in `warehouse-schema.ts` /
  `warehouse_schema.py`.
- `normalizeResult`/`zipRow` pattern to analog: `http-query-adapter.ts:221`, `:395`.

## Shipped
