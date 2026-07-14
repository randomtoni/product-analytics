---
id: E21-S5-warehouse-breakdown-fix
epic: E21-OBS-protocol-neutrality-gate
status: ready-for-dev
area: query
touches: [node, adapters, observability]
depends_on: [E21-S3-e2e-zero-egress-acceptance-test]
api_impact: additive
---

# E21-S5-warehouse-breakdown-fix — warehouse breakdown groups on the typed view (Defect 3 fix)

## Why

The E1 capstone (E21-S3) surfaced Defect 3 on real Postgres: **every** warehouse breakdown query
(trend/funnel/retention, BOTH trees) fails with `column "properties" does not exist`. All three
builders emit `GROUP BY (properties ->> '<key>')` selecting `FROM events_typed` — but the E17 typed
view projects only base columns + one safe-cast column per DECLARED event property; it never exposes
raw `properties`. It was invisible because all E18/E19 tests are fake-backed (fakes never resolve
column names). This story fixes the SQL-gen in both trees, reconciles the frozen
`WAREHOUSE-SCHEMA-CONTRACT.md`, and re-adds the real-PG breakdown coverage that E21-S3 descoped — so
the cycle closes with WORKING breakdown, not a known-broken path the S4 recipe would have to document
as a limitation.

## Scope

### In

- **The breakdown SQL-gen fix in both trees** — group on the declared typed view column, never on
  raw `properties`. The leaf changes from `properties ->> '<key>'` to `("<key>")::text` (a quoted
  identifier, text-cast) in all three primitives; the CTE / JOIN / ORDER-BY structure is UNCHANGED:
  - `python/src/analytics_kit/query/warehouse_sql.py` — trend (~L166), funnel (~L279), retention
    (~L400).
  - `ts/packages/node/src/query/warehouse-sql.ts` — trend (~L122), funnel (~L234), retention (~L346).
- **Undeclared-breakdown-key error at SQL-gen time** — if `spec.breakdown` names a key NOT in the
  declared event-property union (the same key set the view projects), the builder RAISES before
  emitting SQL, with the offending key + the declarable-key set. No empty-result silent-swallow; no
  query-time-only failure.
- **Thread the taxonomy the last hop** so the builders know the declared key set (see Technical
  notes §5) — `create_query_client`/`createQueryClient` already hold it; it is dropped at
  `create*WarehouseQueryAdapterFromConfig` today. Pass it through the factory → adapter → the four
  `build_*_sql` calls.
- **`WAREHOUSE-SCHEMA-CONTRACT.md` reconciliation** — add the "breakdown is a typed-view column,
  never a raw-JSONB read" clause under §"The typed-VIEW generation rule"; strike the self-granted
  "EXCEPT the breakdown path" comments in both SQL modules. Line 72 stays VERBATIM (this tightens the
  contract back to its own invariant; it does NOT open the one-way door).
- **E18 breakdown-fixture / test reconciliation** — the neutral ROWS stay LOCKED
  (`query-contract.fixtures` + the `warehouse-row-parity` tests assert rows, not SQL — untouched).
  Only the fake-backed **SQL-string assertions** in the warehouse-adapter tests change (they pin
  `"properties ->> 'plan'"` / `"GROUP BY ..., properties ->> 'plan'"` / `"properties ->> 'plan' AS
  bd"` — these become the `("plan")::text` form). Add a `number`-keyed breakdown fixture pinning the
  exact neutral string (see §4b).
- **A real-PG breakdown scenario** behind the E21-S3 needs-Postgres tier
  (`@pytest.mark.needs_postgres` + `skipif(DATABASE_URL is None)` / TS
  `describe.skipIf(!process.env.DATABASE_URL)`) that machine-checks a breakdown trend + funnel +
  retention over real Postgres 16, asserting the neutral rows equal the hand-computed per-group
  counts — re-adding what E21-S3 descoped. Reuse E21-S3's Docker-PG16 provisioning + throwaway-DB
  isolation pattern.

### Out

- Exposing raw `properties` in the typed view / any `WAREHOUSE-SCHEMA-CONTRACT.md` amendment that
  relaxes line 72 — REJECTED (option b). This story tightens, it does not relax.
- Breakdown on UNDECLARED keys as a capability — undeclared is a taxonomy error, by design.
- Any HTTP-adapter change — the HTTP breakdown path (reads engine `breakdown_value`) is untouched
  and already correct; only a parity NOTE is recorded (§6), no cross-adapter numeric-breakdown
  fixture is built here (none exists to reconcile).
- Authoring a CI workflow — the needs-Postgres tier is already CI-ready from E21-S3; this story adds
  scenarios to it, it does not stand up CI (the DEFERRED follow-up per the E21-S3 user decision).
- The four non-breakdown query paths — already proven count-faithful on real PG16 by E21-S3.

## Acceptance criteria

- [ ] All three warehouse breakdown builders (trend/funnel/retention, both trees) group on
      `("<key>")::text` over `events_typed` — **zero `properties ->>` in the breakdown path** (the
      only remaining `properties ->>` in the codebase is the view generator's own safe-cast
      projections in `warehouse_schema.py` / `warehouse-schema.ts`).
- [ ] A breakdown trend + funnel + retention run to completion on **real Postgres 16** (no
      `column "properties" does not exist`), returning neutral rows that equal the hand-computed
      per-group counts — behind the needs-Postgres tier, in BOTH trees at parity.
- [ ] An undeclared breakdown key RAISES at SQL-gen time (unit-testable, no DB), naming the key + the
      declarable-key set; no SQL is emitted.
- [ ] The neutral `breakdown` ROW field is byte-identical to the locked fixtures — including a NEW
      `number`-keyed breakdown fixture asserting the exact string (`'42'`, not `'42.0'`/`Decimal`),
      proving the `::text` cast holds cross-tree parity (Python vs JS driver rendering).
- [ ] The emitted breakdown SQL is byte-identical Postgres across both trees (the existing
      byte-identical-SQL parity pins updated to the new leaf).
- [ ] `WAREHOUSE-SCHEMA-CONTRACT.md` carries the "breakdown is a typed-view column" clause; line 72
      is unchanged; the self-granted "EXCEPT the breakdown path" comments are struck from both SQL
      modules.
- [ ] All four TS gates + the neutrality scan stay green; Python `pytest`/`ruff`/`mypy` + the Python
      scan analog stay green. Depends on E21-S3 (the needs-Postgres tier + PG16 provisioning it
      established).

## Technical notes

Locked by an architect consult (2026-07-14) on the load-bearing design question (it touches the
frozen `WAREHOUSE-SCHEMA-CONTRACT.md`). Pin this design verbatim — do not re-litigate.

- **DECISION: option (a) — breakdown only on DECLARED typed columns; undeclared key ⇒ error at
  SQL-gen time.** The breakdown path stops touching `properties` entirely and groups on the
  already-projected typed view column named for the breakdown key. Chosen because it is the only
  option that honors `WAREHOUSE-SCHEMA-CONTRACT.md:72` as written ("Query SQL never targets
  `properties` directly" is an unconditional invariant the breakdown path had been silently violating
  via an exception the contract never authorized); it aligns with the taxonomy-first + "port only
  what's needed" postures (breakdown-by-arbitrary-property was never scoped in `BRIEF.md`); and the
  view ALREADY projects every declarable breakdown target (one safe-cast column per declared event
  prop, aliased to the prop key), so the fix is to REFERENCE that column, not re-derive it. REJECTED
  (b) expose raw `properties` in the view — a one-way-door amendment to a frozen contract to rescue an
  unscoped capability, and it reintroduces the trait/group nesting-guard hazard (`set`/`group_type`/…
  live in `properties`). REJECTED (c) hybrid — keeps the forbidden `properties ->>` line AND two
  divergent extraction semantics side by side (worst of both). — architect (2026-07-14)
- **SQL-GEN SHAPE (all three primitives, both trees).** The view generator aliases each projection
  with `_quote_ident(key)` / `quoteIdent(key)` — the alias IS the raw prop key (double-quoted). So
  the breakdown leaf becomes the quoted identifier, TEXT-CAST (see §4b), replacing the JSONB-path
  literal:
  ```
  # BEFORE:  breakdown_path = f"properties ->> {_quote_literal(breakdown)}"   → properties ->> 'plan'
  # AFTER:   breakdown_col  = f"({_quote_ident(breakdown)})::text"            → ("plan")::text
  ```
  Interpolate `breakdown_col` everywhere the code currently interpolates `breakdown_path`; the
  CTE/JOIN/ORDER-BY structure is UNCHANGED (trend `series`/CROSS JOIN/`IS NOT DISTINCT FROM`; funnel
  `matched → anchor (array_agg…[1]) → walk` carry-through + `GROUP BY … w.bd`; retention `cohort`
  select + `GROUP BY` + grid/cells join + `ORDER BY g.bd`). Funnel `matched` selects `FROM
  events_typed e`, so `e."plan"` resolves for any declared key; a step whose event never carries that
  prop yields NULL from the safe-cast view (same null-breakdown-group behavior as before). — architect
  (2026-07-14)
- **§4b — `::text` IS LOAD-BEARING (the load-bearing subtlety — do not drop it).** The neutral
  `breakdown` row field is LOCKED (`QUERY-ROW-CONTRACT.md`) and the row builders stringify the cell
  with `str(...)` / `String(...)`. Under the OLD code `properties ->> 'key'` returned Postgres TEXT,
  so `str()`/`String()` was a no-op. Under (a), grouping on a TYPED safe-cast column means a
  non-string breakdown key would render DRIVER-dependently and DIVERGE cross-tree: a `boolean` prop →
  Python `str(True)`='True' vs JS driver `'true'`; a `number` → `Decimal('42')`/`'42.0'` vs `'42'`; a
  `date` → tz/format drift. **Fix: cast the breakdown column to `text` in the SQL** — `("<key>")::text`
  — so Postgres renders the string deterministically (identical across both trees, `to_char`-style
  immune to driver/session settings). Group AND carry the `::text` form throughout (so `GROUP BY`, the
  `series`/`buckets` DISTINCT, and the `IS NOT DISTINCT FROM` join keys all agree on the text-typed
  value). `::text` is identity for a `string`/`text` prop (existing string-keyed fixtures pass
  unchanged) and deterministic for the rest. **Pin it** with a NEW fixture breaking down on a declared
  `number` prop, asserting the exact string (`'42'`, not `'42.0'`/`Decimal`). — architect (2026-07-14)
- **§3 — UNDECLARED KEY ⇒ RAISE AT SQL-GEN TIME, in the builder.** An undeclared breakdown key is a
  consumer taxonomy mistake, not a legitimate empty dataset — an empty result would silently swallow a
  typo (`"pln"` for `"plan"`) and return a plausible zero-series (the worst analytics failure mode).
  Raise with the offending key + the declarable-key set. Enforce at SQL-gen time (fully unit-testable
  against the taxonomy, no DB) — NOT query time (letting Postgres raise `column "pln" does not exist`
  is today's defect re-skinned: real-PG-only, invisible to the fake suite). Check against the
  `decl.events` prop-key union — `_collect_projection_keys` / `collectProjectionKeys` in
  `warehouse_schema.py` / `warehouse-schema.ts` — the SAME set the view projects, so "breakdown key ⇒
  a column the view actually projects" holds by construction. — architect (2026-07-14)
- **§4 — CONTRACT AMENDMENT: reconciliation, NOT capability expansion.** Amend
  `WAREHOUSE-SCHEMA-CONTRACT.md` — add a short subsection under §"The typed-VIEW generation rule"
  (after L89) stating breakdown positively as an in-view read, so no future story re-grants the
  exception the SQL modules had claimed. Line 72 stays VERBATIM. Suggested prose:
  > **### Breakdown is a typed-view column, never a raw-JSONB read**
  > A query `breakdown` groups on the **typed view column** projected for the breakdown key — never
  > on `properties ->> '<key>'`. The breakdown key must be a **declared event property** (the same key
  > set the view projects), so it always has a safe-cast column in `events_typed`; the query groups on
  > `("<key>")::text` so the neutral `breakdown` string is rendered deterministically by Postgres
  > (identical across both trees, independent of driver/session settings) regardless of the property's
  > declared `PropType`. A breakdown naming an **undeclared** key is a taxonomy error raised at
  > SQL-generation time — the query is never emitted. This upholds §"Query SQL never targets
  > `properties` directly" without exception.
  And STRIKE the self-granted "EXCEPT the breakdown path" comments (`warehouse_sql.py:10-13`,
  `warehouse-sql.ts:27-29`) — they asserted an authorization the contract never gave and are now
  false; replace with a one-line "breakdown groups on the typed view column." This is the
  "delete the self-granted exception" path, explicitly NOT "authorize a properties-exposing
  amendment." — architect (2026-07-14)
- **§5 — SIGNATURE / WIRING RIPPLE (the one non-trivial ripple; ~4 files per tree).** The builders
  need the declared-event-prop key set to enforce §3, and the spec alone does not carry it. So
  `build_trend_sql(spec)` / `buildTrendSql(spec)` (+ funnel/retention/unique_count) gain a second
  argument — the `Taxonomy` (or a precomputed `set[str]`/`Set<string>` of declarable keys). The
  taxonomy is ALREADY in scope one hop up but dropped: `create_query_client`/`createQueryClient`
  receive `config … & { taxonomy }` (`ts/.../create-query-client.ts:9`), but
  `create_warehouse_query_adapter_from_config` / `createWarehouseQueryAdapterFromConfig` receive ONLY
  `{ warehouse_dsn }` / `{ warehouseDsn }` (`ts/.../warehouse-query-adapter.ts:129-133`,
  `python/.../warehouse_adapter.py`), and `WarehouseQueryAdapter` holds only `dbExecute`. **Thread
  `taxonomy` (or the derived key set) through the from-config factory → into the adapter (store it) →
  into each `build_*_sql` call.** The adapter is already generic on `<TX extends TaxonomyShape>` in
  TS, so this is a runtime-VALUE plumbing change, not a type-shape change. The HTTP adapter is
  untouched (it emits no view SQL). Also: `_quote_literal` / `quoteLiteral` in the SQL modules becomes
  DEAD after this change (it only built the JSONB key literal) — remove it; the builder now needs
  `_quote_ident` / `quoteIdent`, which already exist in the schema module — the cleanest move is to
  EXPORT them from the schema module and IMPORT into the SQL module, so the view generator and the
  breakdown path quote identifiers through ONE shared function (restoring the "view and breakdown share
  one story" property the old comment claimed but the old code violated). — architect (2026-07-14) +
  PM-verified adapter/factory wiring (2026-07-14)
- **CROSS-TREE SQL PARITY.** The emitted leaf changes to `("key")::text` identically in both trees;
  both already share identical `_quote_ident`/`quoteIdent` escaping (double the `"`); the `::text` cast
  is the same three chars. Byte-identical SQL parity holds; update the existing
  byte-identical-SQL/`warehouse-row-parity` expected strings to the new leaf. Row-assertion tests
  (`warehouse-row-parity.test.ts` / `test_warehouse_row_parity.py`) feed canned `DbExecuteResult`s and
  assert ROWS — they are UNTOUCHED by the SQL change. — architect (2026-07-14)
- **§6 — HTTP-ADAPTER PARITY NOTE (record, do NOT build).** The HTTP breakdown reads engine
  `breakdown_value` → neutral `breakdown`; the warehouse now reads `("<key>")::text` → neutral
  `breakdown`. Both land in the same LOCKED field via the shared row builders. For a numeric breakdown
  to agree byte-for-byte ACROSS the two adapters, the warehouse `::text` rendering must match what the
  HTTP engine emits for the same value. Shipped fixtures are string-keyed, so this holds today. If a
  future fixture breaks down on a numeric prop across BOTH adapters, assert both produce the identical
  neutral string and reconcile if they diverge. Flag the invariant; do NOT design further — no
  cross-adapter numeric-breakdown fixture exists to reconcile now. — architect (2026-07-14)
- **REAL-PG BREAKDOWN SCENARIO — reuse E21-S3's tier + provisioning.** Add the breakdown trend/funnel/
  retention scenarios to the E21-S3 needs-Postgres tier: Python `@pytest.mark.needs_postgres` +
  `skipif(DATABASE_URL is None)` (the marker is already registered in `python/pyproject.toml` by
  E21-S3); TS `describe.skipIf(!process.env.DATABASE_URL)` colocated in `ts/packages/node/src` under
  the existing `test` turbo task (whose `env: ["DATABASE_URL"]` cache-key E21-S3 already added). Reuse
  E21-S3's Docker `postgres:16` provisioning + throwaway-schema/DB-per-run isolation. Seed rows with
  a declared breakdown prop; assert per-group counts equal the hand-computed grid. This RE-ADDS the
  breakdown scenario E21-S3 DESCOPED (recorded in its `## Shipped`). — architect (2026-07-14) +
  E21-S3 provisioning pattern
- **VENDOR-NEUTRAL SCOPE.** All changes are behind the frozen neutral seam: the emitted SQL leaf, a
  gen-time taxonomy check, a taxonomy plumbing hop, and a contract-doc reconciliation. Nothing a
  consumer observes changes shape; the neutral `breakdown` row field is preserved byte-identical.
  `api_impact: additive` — no public surface is removed or renamed (the builder signatures are
  internal to the node target).

## Shipped

<!-- Filled by /implement-epics on move to 5-done. -->
