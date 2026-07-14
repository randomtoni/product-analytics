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
  notes §5 / §5a / §5b / §5c) — `create_query_client`/`createQueryClient` already hold it on
  `config.taxonomy`; it is dropped at `create*WarehouseQueryAdapterFromConfig` today. Store it on the
  adapter and derive the key set for the four `build_*_sql` calls. NOTE the per-tree asymmetry (§5a:
  Python's factory already gets the whole config; TS's gets a stripped `{ warehouseDsn }` and needs
  the extra `taxonomy` pass-through) AND the test-surface migration (§5c: the DI constructor gains an
  optional taxonomy and ~18–21 breakdown tests per tree must supply one).
- **`WAREHOUSE-SCHEMA-CONTRACT.md` reconciliation** — add the "breakdown is a typed-view column,
  never a raw-JSONB read" clause under §"The typed-VIEW generation rule"; strike the self-granted
  "EXCEPT the breakdown path" comments in both SQL modules. Line 72 stays VERBATIM (this tightens the
  contract back to its own invariant; it does NOT open the one-way door).
- **E18 breakdown-fixture / test reconciliation** — the neutral ROW ASSERTIONS stay LOCKED (the
  `query-contract.fixtures` files are HTTP-wire only — untouched; the `warehouse-row-parity` tests
  assert ROWS, so their existing string-keyed breakdown fixtures keep their expected rows). What
  changes are the **inline fake-backed SQL-string assertions** in the warehouse-adapter tests
  (`warehouse-query-adapter.test.ts` / `test_warehouse_query_adapter.py`): the ~9 breakdown assertions
  per tree — trend (`"properties ->> 'plan'"` + `"GROUP BY date_trunc('day', timestamp), properties
  ->> 'plan'"`, TS ~L198-199 / Py ~L268-269), funnel (`"properties ->> 'plan' AS bd"`, TS ~L635 / Py
  ~L666), retention (`"properties ->> 'plan' AS bd"`, TS ~L963 / Py ~L972) — become the `("plan")::text`
  form. NOTE the two `o'brien` embedded-single-quote tests (TS ~L360 trend + ~L999 retention; Py ~L422
  + ~L1016) change ESCAPING SEMANTICS, not just the leaf: `properties ->> 'o''brien'` (literal-quoting,
  single-quote doubled) becomes `("o'brien")::text` (identifier-quoting via `quoteIdent`, which doubles
  a `"` and passes a `'` through) — do NOT blind-`sed` these; the escape is genuinely different. The
  no-breakdown `_CANONICAL_*_SQL` byte-identical parity constants embed NO breakdown leaf, so they are
  UNTOUCHED. Then add the `number`-keyed breakdown fixture (see §4c) to the row-parity tests. Do NOT
  touch the view-generator's OWN `properties ->>` projections in `warehouse-schema.*` or their tests
  (`warehouse-schema.test.ts` / `test_warehouse_schema.py`) — those are the legitimate remaining
  `properties ->>` per AC-1.
- **A real-PG breakdown scenario** behind the E21-S3 needs-Postgres tier
  (`@pytest.mark.needs_postgres` + `skipif(DATABASE_URL is None)` / TS
  `describe.skipIf(!process.env.DATABASE_URL)`) that machine-checks a breakdown trend + funnel +
  retention over real Postgres 16, asserting the neutral rows equal the hand-computed per-group
  counts — re-adding what E21-S3 descoped. Reuse E21-S3's `scoped_dsn` throwaway-DB-per-run
  provisioning + isolation pattern (a `CREATE DATABASE e21s3_<uuid>` against the `DATABASE_URL`
  Postgres, migrated + dropped per run — see Technical notes).

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
      `("<key>")::text` over `events_typed` — **zero `properties ->>` in the breakdown path**, in
      emitted SQL AND in the SQL modules' prose (the only remaining `properties ->>` in the codebase
      is the view generator's own safe-cast projections in `warehouse_schema.py` /
      `warehouse-schema.ts` and their tests `test_warehouse_schema.py` / `warehouse-schema.test.ts` —
      those are untouched).
- [ ] A breakdown trend + funnel + retention run to completion on **real Postgres 16** (no
      `column "properties" does not exist`), returning neutral rows that equal the hand-computed
      per-group counts — behind the needs-Postgres tier, in BOTH trees at parity.
- [ ] An undeclared breakdown key RAISES at SQL-gen time (unit-testable, no DB), naming the key + the
      declarable-key set; no SQL is emitted.
- [ ] A breakdown query when `warehouseDsn` is present but `taxonomy` is ABSENT RAISES at SQL-gen with
      a DISTINCT config error (per §3a) — not the generic undeclared-key error — while the four
      non-breakdown primitives + `raw_query` still run unchanged with no taxonomy. Same posture both
      trees.
- [ ] The neutral `breakdown` ROW field is byte-identical to the locked fixtures — including a NEW
      `number`-keyed breakdown fixture (per §4c) whose two halves both hold: (1) the row-builder
      stringifies a numeric cell to the exact string (`'42'`, not `'42.0'`/`Decimal`) cross-tree; (2)
      the real-PG scenario proves Postgres `numeric::text` renders `'42'` end-to-end (the only place
      the `::text` cast actually executes).
- [ ] The emitted breakdown SQL is byte-identical Postgres across both trees (the shared
      `_quote_ident`/`quoteIdent` yields the same `("<key>")::text` leaf; the inline breakdown SQL
      assertions in both trees' adapter tests updated to the new leaf — the no-breakdown
      `_CANONICAL_*_SQL` parity constants are unaffected).
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
  with `_quote_ident(key)` / `quoteIdent(key)` — the alias IS the raw prop key (double-quoted),
  VERIFIED against `warehouse_schema.py:97` / `warehouse-schema.ts:80` (`alias = quoteIdent(key)`),
  so `("plan")::text` groups on the real projected `plan` column. So the breakdown leaf becomes the
  quoted identifier, TEXT-CAST (see §4b), replacing the JSONB-path literal — using the SAME
  `_quote_ident`/`quoteIdent` now shared from the schema module (§5b), not a local quoter:
  ```
  # BEFORE:  breakdown_path = f"properties ->> {_quote_literal(breakdown)}"   → properties ->> 'plan'
  # AFTER:   breakdown_col  = f"({_quote_ident(breakdown)})::text"            → ("plan")::text
  #          (_quote_ident/quoteIdent now IMPORTED from warehouse_schema, shared with the view gen)
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
  — so Postgres (not the client driver) renders the string, removing the Python-vs-JS DRIVER
  divergence. Group AND carry the `::text` form throughout (so `GROUP BY`, the `series`/`buckets`
  DISTINCT, and the `IS NOT DISTINCT FROM` join keys all agree on the text-typed value). `::text` is
  identity for a `string`/`text` prop (existing string-keyed fixtures pass unchanged), and for
  `number`→`numeric::text` / `boolean`→`boolean::text` it renders a canonical, session-INDEPENDENT
  string (`42`, `42.5`, `true`/`false`).
  - **CAVEAT — a `date`-typed breakdown is NOT fully session-independent.** `date`→`timestamptz::text`
    renders per session `DateStyle`/`TimeZone` — this is the SAME inherent-cast non-determinism the
    epic's dev-prerequisites already acknowledge (E21 epic, "`text→timestamptz` casts are
    session-`DateStyle`/`TimeZone`-dependent for ambiguous inputs … a query-time expectation note, not
    a defect"). `::text` fixes the DRIVER-rendering divergence (Python `Decimal`/`bool` repr vs JS
    number/bool string) for numeric/boolean/string keys; it does NOT make a `date` breakdown's rendered
    string session-immune the way the bucket columns' `to_char` is. Do NOT claim blanket
    `to_char`-style immunity. A `date`-typed breakdown is an accepted documented divergence, not a
    target to make byte-stable here.
  **Pin the numeric case** with a NEW fixture breaking down on a declared `number` prop, asserting the
  exact string (`'42'`, not `'42.0'`/`Decimal`) — see §4c for WHERE it lives and its two halves. —
  architect (2026-07-14)
- **§4c — WHERE THE NUMBER-KEYED FIXTURE LIVES, AND ITS TWO HALVES.** The `query-contract.fixtures`
  files are HTTP-WIRE (`WireRowFixture`) fixtures — they carry NO warehouse `DbExecuteResult` shapes,
  so the number-keyed breakdown fixture does NOT go there (they stay untouched). The warehouse breakdown
  fixtures live inline in the ROW-PARITY tests (`warehouse-row-parity.test.ts` /
  `test_warehouse_row_parity.py`) and are string-keyed only today (`'pro'`/`'free'`). The `::text` proof
  has TWO halves, because a FAKE `DbExecuteResult` echoes whatever cell you seed (the fake never runs
  `::text`): (1) a ROW-BUILDER fixture proving the neutral row stringifies a numeric cell as `'42'`
  (`str(42)` / `String(42)`) — add a `number`-keyed breakdown `DbExecuteResult` to the row-parity
  tests, mirrored cross-tree; (2) the REAL-PG scenario (below) proving Postgres `numeric::text` renders
  `'42'` end-to-end (the only place the cast actually executes). Both halves are required — half (1)
  alone would pass even if the SQL forgot the `::text` cast. — refinement code-read (2026-07-14)
- **§3 — UNDECLARED KEY ⇒ RAISE AT SQL-GEN TIME, in the builder.** An undeclared breakdown key is a
  consumer taxonomy mistake, not a legitimate empty dataset — an empty result would silently swallow a
  typo (`"pln"` for `"plan"`) and return a plausible zero-series (the worst analytics failure mode).
  Raise with the offending key + the declarable-key set. Enforce at SQL-gen time (fully unit-testable
  against the taxonomy, no DB) — NOT query time (letting Postgres raise `column "pln" does not exist`
  is today's defect re-skinned: real-PG-only, invisible to the fake suite). Check against the
  `decl.events` prop-key union — `_collect_projection_keys` / `collectProjectionKeys` in
  `warehouse_schema.py` / `warehouse-schema.ts` — the SAME set the view projects, so "breakdown key ⇒
  a column the view actually projects" holds by construction. — architect (2026-07-14)
- **§3a — NO-TAXONOMY WAREHOUSE EDGE (posture — pin it; do not let the builder invent it).**
  `taxonomy` is OPTIONAL on `QueryClientConfig` in both trees (`taxonomy?` TS / `taxonomy: Taxonomy |
  None = None` Python); the warehouse rung is selected by `warehouseDsn` PRESENCE alone and does NOT
  require a taxonomy. The e2e loop always supplies both (`QueryClientConfig(warehouse_dsn=…,
  taxonomy=TAXONOMY)`, `test_e2e_zero_egress.py:278-281`), but nothing FORCES it — so `warehouseDsn`
  present + `taxonomy` absent is a reachable state with no declared-key set. **Posture (stance c):**
  the adapter still constructs, and the four non-breakdown primitives + `raw_query` work UNCHANGED
  (they never touch the declared-key set). A **breakdown** query in this state RAISES at SQL-gen with a
  DISTINCT config error — "a warehouse breakdown query requires a taxonomy on QueryClientConfig" — NOT
  the generic undeclared-key error (the cause is missing config, not an undeclared key; name the actual
  fix). Both trees emit the same posture and an equivalent message (following each tree's own error
  convention: TS `throw new Error('analytics: …')`, Python `raise ValueError('analytics-kit: …')` — the
  prefix asymmetry is pre-existing, do NOT reconcile it here). Rejected (b) "skip the check when no
  taxonomy" — that re-admits the exact query-time-failure defect class this story exists to kill.
  Rejected the cheaper (a) "empty key set ⇒ generic undeclared-key error" — it mislabels a
  missing-config as an undeclared key and sends the consumer to fix the wrong thing. — architect
  (2026-07-14)
- **§4 — CONTRACT AMENDMENT: reconciliation, NOT capability expansion.** Amend
  `WAREHOUSE-SCHEMA-CONTRACT.md` — add a short `###` subsection under §"The typed-VIEW generation
  rule", placed AFTER the main rule text ends (the base-columns-carry-through sentence, ~L88-89) and
  BEFORE the existing `### Deterministic column order (what makes parity byte-exact)` subsection
  (~L91), so it reads as the first sub-subsection of the typed-VIEW rule. State breakdown positively
  as an in-view read, so no future story re-grants the exception the SQL modules had claimed. Line 72
  stays VERBATIM (verified: "Query SQL (E18) **never targets `properties` directly**" — an
  unconditional invariant, unchanged). This edits a FROZEN one-way-door doc DELIBERATELY: it is a
  RECONCILIATION (deleting a broken self-granted exception, tightening the doc back to its own
  invariant), NOT an expansion of the one-way door — the amendment adds no new capability and relaxes
  no rule. Suggested prose:
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
  amendment." Also sweep the SQL modules' OTHER `properties ->>` PROSE so the AC-1 "zero `properties
  ->>` in the breakdown path" holds in comments too, not just emitted SQL: the `build_funnel_sql`
  method-doc ("reaches the SQL as an escaped JSONB path"), the `build_retention_sql` method-doc, and
  the `_retention_walk_sql` / `retentionWalkSql` doc ("`properties ->> key`, escaped exactly as
  trend/funnel") each describe the old JSONB-path behavior — update them to the "typed view column,
  `("<key>")::text`" behavior. These are dev-facing comments, not the emitted SQL, but leaving them
  stale would contradict AC-1's spirit and mislead the next reader. — architect (2026-07-14) +
  refinement code-read (2026-07-14)
- **§5 — SIGNATURE / WIRING RIPPLE (the one non-trivial ripple).** The builders need the
  declared-event-prop key set to enforce §3, and the spec alone does not carry it. So
  `build_trend_sql(spec)` / `buildTrendSql(spec)` (+ funnel/retention/unique_count) gain a second
  argument — the declarable-key set (`set[str]`/`ReadonlySet<string>`) derived from
  `taxonomy.decl['events']`. The taxonomy is ALREADY in scope one hop up: BOTH
  `create_query_client`/`createQueryClient` implementation bodies see it — TS on `config.taxonomy`
  (`QueryClientConfig.taxonomy?`, `ts/.../config.ts:18`; the impl signature is `config:
  QueryClientConfig`, so `config.taxonomy` is reachable at the warehouse branch,
  `create-query-client.ts:21-24`), Python on `config.taxonomy` (`config.py:47`). It is DROPPED at the
  from-config factory today. **Thread `taxonomy` through the from-config factory → into the adapter
  (STORE it as a field — neutral config, not a driver handle, so this honors E17-S4's "adapter holds
  only DbExecute, never a DSN/driver handle" rule) → derive the key set → pass to each `build_*_sql`
  call.** The adapter is already generic on `<TX extends TaxonomyShape>` in TS, so this is a
  runtime-VALUE plumbing change, not a type-shape change. The HTTP adapter is untouched (it emits no
  view SQL).
- **§5a — THE FROM-CONFIG FACTORY IS ASYMMETRIC ACROSS TREES (verify the exact per-tree edit).** The
  two from-config factories DO NOT have the same signature today, so the threading edit differs per
  tree:
  - **Python** — `create_warehouse_query_adapter_from_config(config: QueryClientConfig)`
    (`warehouse_adapter.py:139`) already receives the WHOLE config, so `config.taxonomy` is ALREADY in
    hand at the factory. The edit is: read `config.taxonomy` here and pass it to the
    `WarehouseQueryAdapter(...)` constructor (which gains a `taxonomy` field). `create_query_client`
    (`factory.py:33-34`) needs NO change — it already forwards the whole `config`.
  - **TS** — `createWarehouseQueryAdapterFromConfig({ warehouseDsn })`
    (`warehouse-query-adapter.ts:129-135`) receives a STRIPPED `{ warehouseDsn }` literal today, and
    `createQueryClient`'s warehouse branch (`create-query-client.ts:21-24`) constructs that literal
    from `config.warehouseDsn` only. So TWO edits: (1) widen the factory arg to `{ warehouseDsn;
    taxonomy? }` and pass `taxonomy` into the `WarehouseQueryAdapter` constructor; (2) at the
    `createQueryClient` warehouse branch, also pass `taxonomy: config.taxonomy`.
  Production files touched per tree: SQL module + adapter module + from-config factory (TS also its
  `createQueryClient` branch; Python's `create_query_client` is untouched). So ~3 prod files (Python)
  / ~3–4 prod files (TS) — but see §5c: the TEST surface is the real cost, undercounted by a naive
  file-count.
- **§5b — SHARE `_quote_ident` / `quoteIdent`; drop the dead `_quote_literal` / `quoteLiteral`.**
  `_quote_literal` / `quoteLiteral` in the SQL modules becomes DEAD after this change (they only built
  the JSONB key literal for the breakdown path) — remove them. The builder now needs `_quote_ident` /
  `quoteIdent`, which today are MODULE-PRIVATE in the schema module (`_quote_ident` is `_`-prefixed and
  absent from `warehouse_schema.py`'s `__all__`; `quoteIdent` is un-`export`ed in
  `warehouse-schema.ts`). EXPORT them from the schema module and IMPORT into the SQL module so the view
  generator and the breakdown path quote identifiers through ONE shared function (restoring the "view
  and breakdown share one story" property the old comment claimed but the old code violated). Keep this
  export INTERNAL to the node package — do NOT re-export `quoteIdent` from the node package `index.ts`
  / the query `__init__.py` public surface (it is a cross-module helper, not consumer API; the node
  index already re-exports `buildTypedViewSql`/`build_typed_view_sql` but not the private quoters, and
  that stays). Same for the declarable-key derivation: `collectProjectionKeys` /
  `_collect_projection_keys` are ALSO module-private today and take the raw `decl['events']`
  (`dict[str, PropDecl]` / `Record<string, PropDecl>`, NOT a `Taxonomy`) — export them too (internal),
  and the builder derives its key set as the keys of `collect_projection_keys(taxonomy.decl['events'])`
  so the check set IS the exact set the view projects, by construction.
- **§5c — TEST-SURFACE RIPPLE (the undercounted cost — flag to the orchestrator).** Once the builder
  requires a declarable-key set, EVERY existing breakdown unit test breaks unless it supplies a
  taxonomy/key-set. The breakdown tests construct the adapter via the low-level DI twin
  (`createWarehouseQueryAdapter({ dbExecute })` / `create_warehouse_query_adapter(db_execute=…)`),
  which today has NO taxonomy slot — so the DI constructor must gain an OPTIONAL taxonomy arg AND every
  breakdown-bearing test must pass one (~21 `breakdown:` specs across ~53 adapter constructions in the
  TS `warehouse-query-adapter.test.ts`; ~18 `breakdown=` specs across ~54 in Python
  `test_warehouse_query_adapter.py`). This is the bulk of the story's real effort — the SQL leaf change
  is small, the test migration is not. Genuinely still ONE story (single defect, single design), but
  size it against the test surface, not the ~3-prod-file count §5/§5a imply. — architect (2026-07-14) +
  refinement code-read (2026-07-14)
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
  retention scenarios to the E21-S3 needs-Postgres tier. Python: the existing
  `test_e2e_zero_egress.py` carries `pytestmark = [pytest.mark.needs_postgres,
  pytest.mark.skipif(not _DATABASE_URL, …)]` (`:54-56`; the marker is registered in
  `python/pyproject.toml` by E21-S3) and provisions a THROWAWAY DATABASE PER RUN via the `scoped_dsn`
  fixture (`CREATE DATABASE e21s3_<uuid>` against `DATABASE_URL`, runs `build_migration_sql(TAXONOMY)`,
  `DROP DATABASE … WITH (FORCE)` on teardown) — NOT Docker/testcontainers inside the test (whether the
  target Postgres is Docker-run is a CI concern the epic owns, not the test's own mechanism). TS: the
  `e2e-zero-egress.test.ts` analog under `ts/packages/node/src` gated by
  `describe.skipIf(!process.env.DATABASE_URL)` under the existing `test` turbo task (whose `env:
  ["DATABASE_URL"]` cache-key E21-S3 already added). Reuse E21-S3's `_ev`/`_batch_body`/`scoped_dsn`
  seeding + throwaway-DB isolation; seed rows carrying a DECLARED breakdown prop (a `number` prop for
  the §4c half-(2) numeric `::text` proof, alongside a string prop), and assert per-group counts equal
  the hand-computed grid. This RE-ADDS the breakdown scenario E21-S3 DESCOPED (recorded at
  `test_e2e_zero_egress.py:240-249` — "needs its own story … cross-tree SQL-gen change + E18 fixture
  rewrite", which is THIS story). — architect (2026-07-14) + E21-S3 provisioning pattern +
  refinement code-read (2026-07-14)
- **VENDOR-NEUTRAL SCOPE.** All changes are behind the frozen neutral seam: the emitted SQL leaf, a
  gen-time taxonomy check, a taxonomy plumbing hop, and a contract-doc reconciliation. Nothing a
  consumer observes changes shape; the neutral `breakdown` row field is preserved byte-identical.
  `api_impact: additive` — no public surface is removed or renamed (the builder signatures are
  internal to the node target).

> Reviewer suggestion (2026-07-14) → E21 improvement pass (cosmetic, cross-tree assertion symmetry): the
> real-PG trend-breakdown proof asserts an exact dict on Python (`total_by_tier == {"42":2,"7":1}`) but
> individual `.get`/`.has` + an explicit `'42.0'`-absent check on TS. Both prove the point (the
> `'42.0'`-absent assertion covers the load-bearing driver-divergence risk); tighten the TS side to an
> exact-map check for symmetry.

## Shipped

> Captured by `implement-epics` on 2026-07-14.

- **Files changed (src):** TS `warehouse-sql.ts` (the `("<key>")::text` leaf + `requireDeclared`/`collectDeclarableKeys` + threading), `warehouse-schema.ts` (export `quoteIdent`/`collectProjectionKeys` internal), `warehouse-query-adapter.ts` (taxonomy field → key set), `create-query-client.ts` (thread `taxonomy`); Python mirrors (`warehouse_sql.py`, `warehouse_schema.py`, `warehouse_adapter.py`). **Contract:** `planning/WAREHOUSE-SCHEMA-CONTRACT.md` (new "Breakdown is a typed-view column" subsection; **line 72 verbatim**). **Tests:** adapter + row-parity + e2e, both trees.
- **New public API:** none consumer-facing — internal builder signatures widened (declarable-key set); the neutral `breakdown` row field is byte-identical (`api_impact: additive`)
- **Tests added/changed:** ~9 inline breakdown SQL assertions per tree → `("plan")::text`; the two `o'brien` tests re-authored to identifier-quoting; +4 error tests/tree (undeclared-key raises + lists set; no-taxonomy distinct config error; no-taxonomy non-breakdown primitives run); a `number`-keyed row-parity fixture (`'42'` not `'42.0'`); the real-PG breakdown trend+funnel+retention scenario (re-added, E21-S3 had descoped it)
- **Commit:** this story's ship commit on `main` (see `git log`)
- **Reviewer notes:** independent gate verdict READY TO SHIP (no criticals) — zero `properties ->>` in the breakdown path (SQL + prose); `::text` cross-tree determinism proven on live PG16.14 (numeric→`'42'`, both halves); errors raise at SQL-gen (not query-time); adapter stores only a reduced neutral key set (no `Taxonomy`/driver leak); contract line-72 verbatim, disciplined reconciliation; `o'brien` escaping change correct; funnel zero-cell consistent. 1 cosmetic suggestion above
- **Cross-story seams exposed:** **warehouse BREAKDOWN now works on real Postgres** — trend/funnel/retention group on the declared typed view column via `("<key>")::text`; undeclared breakdown key = a taxonomy error at SQL-gen; the contract's "never target `properties` directly" now holds WITHOUT the self-granted exception. **S4** can document WORKING breakdown (declared-typed-column semantics; a `date` breakdown renders session-dependently — a documented divergence). The self-host query side is now capability-complete on real Neon.

## Follow-up

> E21 improvement pass (2026-07-14) — cosmetic, test-only, no semantics change.

- Tightened the TS real-PG trend-breakdown assertion to an exact-map check — `expect(new Set(totalByTier.entries())).toEqual(new Set([['42', 2], ['7', 1]]))` — mirroring Python's exact-dict `== {"42": 2, "7": 1}`. The `'42.0'`-absent and per-row `typeof … === 'string'` checks are retained.
