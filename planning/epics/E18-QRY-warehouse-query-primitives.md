---
id: E18-QRY-warehouse-query-primitives
status: active
area: query
touches: [adapters, node]
api_impact: additive
blocked_by: []
updated: 2026-07-14
---

# E18-QRY-warehouse-query-primitives — Warehouse query primitives: SQL over the typed view, byte-identical neutral rows

## Why

E15/E16 proved the read-side row contract is backend-agnostic, and E8 documented the intended
per-method SQL mapping — but the `WarehouseQueryAdapter` still `throw`s/`raise`s on every call. Nothing
reads a consumer's warehouse. This epic implements the four structured primitives + `rawQuery` as SQL
over the E17 taxonomy-generated typed VIEW, normalizing driver rows into the **same** neutral
`QueryResult[TrendRow|FunnelStepRow|RetentionRow|UniqueCountRow]` the HTTP adapter already returns —
the read-side half of the self-host acceptance bar. This is the bar-A read-side proof made real: a SQL
backend populates the identical documented rows, so any consumer keying on them survives the
provider swap.

## Success criteria

- The four structured primitives + `rawQuery` on `WarehouseQueryAdapter` **compute** (no more
  not-implemented throw), emitting SQL over the E17 typed view via the injected DB-execute seam.
- **Rows are byte-identical to the HTTP adapter's BY CONSTRUCTION:** SQL counts are fed into the SAME
  existing row-builders (`buildTrendRows`/`buildFunnelRows`/`buildRetentionRows` TS,
  `_build_*_rows` Python) / normalizers, so `conversionRate` stays COMPUTED in the normalizer, not in
  SQL. Proven against the `query-contract.fixtures` (parity-by-mirror across both trees —
  `ts/packages/node/src/query/query-contract.fixtures.ts` + `python/tests/query_contract_fixtures.py`,
  not one shared file) — SQL-shaped inputs produce identical neutral rows.
- `trend` / `unique_count`: date_trunc bucket + count (`count(*)` / `count(distinct distinct_id)`),
  `GROUP BY properties->>breakdown`, empty buckets zero-filled via `generate_series`.
- `funnel`: per-actor ordered-step-within-window (strictly increasing step timestamps within
  `spec.within`, **window measured from step 0**), with adversarial tests (out-of-order, boundary,
  partial completion).
- `retention`: cohort self-join, **`period_index = 0` is the cohort's own period**,
  `count(distinct distinct_id)` per (cohort, period) cell, with adversarial tests.
- `raw_query`: passes `expr` to the SQL engine AS SQL (the deliberate **dialect split** vs HogQL for
  the HTTP adapter); documented that `raw_query` is **NOT provider-swap-portable**.
- Funnel/retention semantics are **correct and well-defined with documented conventions**
  (window-from-step-0; cohort `period_index=0`) — NOT byte-exact HogQL parity.
- **Bar A re-proven at the row level:** the warehouse adapter returns the same neutral rows as the HTTP
  adapter, zero consumer change on swap. **Bar B intact:** selection is config-only (E17 ladder).
- TS/Python parity on all five primitives; all gates green in both trees + both neutrality scans. All
  buildable/testable against the injected fake DB-execute seam — no real Postgres needed for this epic.

## Stories

Drafted to `stories/2-ready-for-dev/` (2026-07-14). Front-loads the SQL-gen + flat-row-builder pattern
(S1), then the two hard adversarial primitives (S2 funnel, S3 retention); S5 is the read-side bar-A
proof. **All five write their OWN flat-row builders** (flatten positional `DbExecuteResult` → the same
neutral row TYPES), reusing the row types + normalizer PATTERN + the `conversionRate`/`period_index`
RULES — NOT the HTTP adapter's nested builders (E17-S3 architect review, 2026-07-14).

- **[E18-S1](../stories/2-ready-for-dev/E18-S1-trend-unique-count-sql.md)** *(additive, no deps)* —
  `trend` + `unique_count` as SQL over the typed view (`date_trunc` bucket + `count(*)`/`count(distinct)`,
  breakdown `GROUP BY properties->>…`, `generate_series` zero-fill); establishes the SQL-gen module + the
  flat-row-builder + shared-assembler pattern S2–S4 reuse. Easy — goes first.
- **[E18-S2](../stories/2-ready-for-dev/E18-S2-funnel-sql-adversarial.md)** *(additive, depends on S1)* —
  `funnel`: per-actor ordered-step-within-window SQL (window from step 0, strictly increasing step
  timestamps), `conversionRate` COMPUTED in the builder (guarded), adversarial tests (out-of-order,
  boundary, partial completion). HARD.
- **[E18-S3](../stories/2-ready-for-dev/E18-S3-retention-sql-adversarial.md)** *(additive, depends on S1)* —
  `retention`: cohort self-join, `period_index=0` = the cohort's own period, `count(distinct distinct_id)`
  per (cohort, period) cell, adversarial tests. HARD.
- **[E18-S4](../stories/2-ready-for-dev/E18-S4-raw-query-dialect-split.md)** *(additive, depends on S1)* —
  `raw_query` passes `expr` to the engine AS SQL, normalized via the columns-present `zipRow` path;
  documents the SQL-vs-HogQL dialect split and that `raw_query` is NOT provider-swap-portable.
- **[E18-S5](../stories/2-ready-for-dev/E18-S5-row-parity-vs-fixtures.md)** *(additive, depends on S1–S4)* —
  bar-A read-side proof: SQL-shaped inputs → assert identical neutral rows vs `query-contract.fixtures`
  (parity-by-mirror across both trees, not a shared file) + the `ENGINE_ROW_FIELD_NAMES` seal.

**Dependency graph:** `S1 → { S2, S3, S4 } → S5`. S1 lands the SQL-gen + flat-builder pattern; S2/S3/S4
each add a per-primitive builder on top of it (and all edit the same adapter file + SQL-gen module, so
they run sequentially in practice); S5 asserts the union of S1–S4 honors the LOCKED row contract.

## Out of scope

- The events schema, typed-view generator, DB-execute seam, config field, and selection ladder —
  **E17** (this epic consumes them).
- The ingest receiver + Neon persistence — **E19** (this epic is the READ side; E19 is the WRITE side).
- Fully-local flags — **E20**.
- The end-to-end zero-egress acceptance test against a real Postgres — **E21** (this epic proves
  row-parity against injected fixtures; E21 proves the full loop against real Postgres).
- **Byte-exact HogQL parity** for funnel/retention — explicitly OUT (see Notes: documented divergence).
- Growing the neutral query interface beyond the four primitives + `rawQuery` — anything else stays
  behind `rawQuery`.

## Notes

Locked by architect consult (2026-07-13) + user decision — do not re-litigate in stories.

- **B — SQL over the taxonomy-generated typed VIEW, normalized through the EXISTING row-builders.** The
  warehouse adapter emits SQL over the E17 typed view and normalizes driver rows into the SAME neutral
  `QueryResult[TrendRow|FunnelStepRow|RetentionRow|UniqueCountRow]` the HTTP adapter returns. REUSE the
  existing `buildTrendRows`/`buildFunnelRows`/`buildRetentionRows` (TS,
  `ts/packages/node/src/query/http-query-adapter.ts`) / `_build_*_rows` (Python,
  `python/src/analytics_kit/query/http_adapter.py`) so warehouse rows are byte-identical to HTTP rows
  BY CONSTRUCTION — feed SQL counts into the same row-builders; **`conversionRate` stays computed in the
  normalizer, not in SQL.** — architect (2026-07-13)
- **B — the driver is injected; this epic needs no real Postgres.** Driver = `psycopg` v3 (Python) /
  `pg` node-postgres (TS), BEHIND the E17 role-named DB-execute seam (no driver handle crosses the
  seam), gated behind the `warehouse` extra / optional peer-dep. Because the seam is INJECTABLE (a fake
  in unit tests, exactly like the existing transport injection), every story here is
  buildable/testable WITHOUT a real Neon. Do NOT set a blocking `blocked_by`. — architect (2026-07-13)
- **B — the easy two vs the hard two.** `trend`/`unique_count` = easy (date_trunc bucket + count,
  `GROUP BY properties->>breakdown`, zero-fill empty buckets via `generate_series`). `funnel` = HARD:
  per-actor ordered-step-within-window (strictly increasing step timestamps within `spec.within`,
  **window measured from step 0**); adversarial tests (out-of-order, boundary, partial completion).
  `retention` = HARD: cohort self-join, **`period_index=0` is the cohort's own period**,
  `count(distinct distinct_id)` per (cohort, period) cell; adversarial tests. Front-load funnel +
  retention. — architect (2026-07-13)
- **B — `raw_query` is the deliberate dialect split.** `raw_query` = SQL dialect (vs HogQL for the HTTP
  adapter). Document that `raw_query` is **NOT provider-swap-portable** — it is the one place a
  dialect-keyed shape legitimately surfaces (consistent with the existing `rawQuery` framing in E8/E15).
  — architect (2026-07-13)
- **User decision — documented divergence, NOT byte-exact PostHog parity.** The consumer is GREENFIELD:
  there is NO existing PostHog deployment or data to match. So the warehouse SQL ships **correct,
  well-defined funnel/retention semantics with the conventions documented** (window-from-step-0; cohort
  `period_index=0`) — **no chase for byte-exact HogQL parity, and no
  posthog-source-guide-against-the-server-repo dependency.** The row-builders are already pinned from
  E15/E16 (`QUERY-ROW-CONTRACT.md` + the parity-by-mirror `query-contract.fixtures` — one file per
  tree, not shared code); this epic feeds SQL counts into them, it does not re-derive the wire shape.
- **The row contract is LOCKED.** Neutral rows are fixed by `planning/QUERY-ROW-CONTRACT.md` and the
  executable `query-contract.fixtures` (mirrored per tree). This epic produces those rows from SQL; it does not re-decide
  the row shape.

## Expansion path

A second self-hosted warehouse dialect is one new DB-execute driver behind the same seam; the SQL
generation and row-builders are reused, zero interface change. The deferred additive query extras
(funnel `medianConversionTime`, trend `aggregated`) populate as new optional row fields from the SQL
side too, zero migration, when they land. `rawQuery` stays the only dialect-specific surface.
