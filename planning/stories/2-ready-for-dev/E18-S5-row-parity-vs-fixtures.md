---
id: E18-S5-row-parity-vs-fixtures
epic: E18-QRY-warehouse-query-primitives
status: ready-for-dev
area: query
touches: [adapters, node]
depends_on: [E18-S1-trend-unique-count-sql, E18-S2-funnel-sql-adversarial, E18-S3-retention-sql-adversarial, E18-S4-raw-query-dialect-split]
api_impact: additive
---

# E18-S5-row-parity-vs-fixtures — bar-A read-side proof: SQL-shaped inputs produce rows identical to the `query-contract.fixtures`

## Why

The whole epic exists to re-prove bar A at the row level: the warehouse adapter must return the SAME
neutral rows as the HTTP adapter, so any consumer keying on them survives the provider swap. This slice
is that proof — feed SQL-shaped inputs (canned `DbExecuteResult`s that the S1–S4 flat-row builders
flatten) and assert the produced neutral rows are IDENTICAL to the `expectedRows` in the executable
`query-contract.fixtures`, in both trees.

## Scope

### In

- Add a **row-parity test** in both trees that, for each structured primitive (`trend`,
  `uniqueCount`, `funnel`, `retention`), drives the warehouse adapter's S1–S3 builders with a canned
  `DbExecuteResult` shaped like the SQL a warehouse would return for that primitive, and asserts the
  produced neutral rows equal the `expectedRows` of the matching `query-contract.fixtures` case:
  - TS: `ts/packages/node/src/query/query-contract.fixtures.ts` (`trendSingleSeries`, `trendBreakdown`,
    `uniqueCountSingleSeries`, `funnelPlain`, `funnelZeroFirstStep`, `funnelEventPrecedence`,
    `funnelBreakdown`, `retentionCohorts`).
  - Python: `python/tests/query_contract_fixtures.py` (the mirrored cases, casing-renamed
    `conversion_rate`/`period_index`).
  - **The fixtures' `wireResults` are HTTP-engine-shaped (nested `days`/`data`, step objects, cohort
    `values`), NOT the warehouse's flat SQL shape.** So this story provides a **SQL-shaped input per
    fixture** — a canned `DbExecuteResult` (positional `rows` + `columns`) representing the flat rows a
    warehouse SELECT would return for the SAME scenario — and asserts the warehouse builders flatten it
    to the SAME `expectedRows`. The parity target is the `expectedRows` (the neutral output), which is
    already identical across both fixtures files. Keep the SQL-shaped inputs readable and co-located with
    the parity test.
  - **`funnelEventPrecedence` — the parity is on the OUTPUT `event`, not the wire precedence walk
    (story-refiner 2026-07-14).** That fixture's `wireResults` exercise the HTTP `custom_name → name →
    action_id` precedence (its `expectedRows` carry `event: 'Renamed Step'`, `'order_placed'`, `'act_3'`).
    The warehouse has NO such wire precedence — per S2, warehouse funnel `event` is the step's own
    identity (from `spec.steps` / the SQL row's event column). So the SQL-shaped input for this case
    supplies each step row already carrying the RESOLVED event identity the fixture's `expectedRows`
    expect (`'Renamed Step'`/`'act_3'`), and the warehouse builder passes them through to the same rows.
    The parity claim is that the OUTPUT `FunnelStepRow.event` values match — NOT that the warehouse
    re-derives them via the HTTP precedence rule (it cannot, and does not need to; the row contract
    fixes the output, not the derivation path). Include this case so the output parity is proven; note
    in the test why the warehouse input is spec-sourced.
- **Assert the byte-identical-by-construction claim concretely:** for at least the guard-critical cases,
  assert the warehouse rows equal the HTTP fixtures' `expectedRows` field-for-field — the computed
  `conversionRate` (guarded, count[0]===0 ⇒ 0) and `periodIndex=0`=cohort-period rules produce the same
  values from SQL counts as from the HTTP wire. This is the read-side bar-A proof made executable.
- **Seal test (leak guard):** serialize the warehouse-produced rows and assert NONE of
  `ENGINE_ROW_FIELD_NAMES` (`breakdown_value`, `average_conversion_time`, `aggregation_value`,
  `aggregated_value`, `converted_people_url`) appears — the same seal the HTTP adapter passes. The
  warehouse never speaks the engine wire, so this should hold trivially; assert it anyway so a future
  regression (e.g. a leaked SQL column alias) fails a gate.
- **TS/Python parity (parity-by-mirror, NOT a shared file):** both trees run the equivalent row-parity
  test against their OWN mirrored fixtures file. The fixtures are already parity-by-mirror (a diff
  between the two files IS the cross-language check); this story adds the warehouse-side assertion in
  each tree, mirrored cell-for-cell — it does NOT introduce a shared fixtures file or cross-tree import.

### Out

- The primitive SQL bodies + builders themselves — **S1/S2/S3/S4** (S5 depends on all four; it asserts
  their OUTPUT matches the contract, it does not implement them).
- Any change to `query-contract.fixtures` (the LOCKED row contract) — cross-reference/consume only; do
  NOT edit the fixtures. If a warehouse builder cannot reproduce a fixture's `expectedRows`, that is a
  BUG in the S1–S3 builder, fixed there — never by relaxing the fixture.
- End-to-end row-parity against a real Postgres (a real SQL SELECT → rows) — **E21** (S5 proves parity
  against canned SQL-shaped `DbExecuteResult`s via the fake; E21 proves it against real Neon).
- Any seam/config/factory change — **E17** (consumed read-only).

## Acceptance criteria

- [ ] A row-parity test in BOTH trees drives the warehouse adapter's builders with SQL-shaped canned
      `DbExecuteResult`s and asserts the produced neutral rows equal the matching
      `query-contract.fixtures` `expectedRows` for `trend`, `uniqueCount`, `funnel` (incl. the
      zero-first-step guard + breakdown), and `retention` (incl. periodIndex=0).
- [ ] The computed fields match by construction: `conversionRate` (guarded) and `periodIndex=0`=cohort
      period produce identical values from SQL counts as the HTTP fixtures' `expectedRows`.
- [ ] A seal test asserts no `ENGINE_ROW_FIELD_NAMES` token appears on any warehouse-produced row.
- [ ] Parity-by-mirror: each tree tests against its OWN fixtures file
      (`query-contract.fixtures.ts` / `query_contract_fixtures.py`); no shared fixtures file, no
      cross-tree import; the two parity tests mirror cell-for-cell.
- [ ] `query-contract.fixtures` is unchanged (the row contract is LOCKED; this story consumes it).
- [ ] Both neutrality scans green; all gates green in both trees.

## Technical notes

This is the read-side bar-A capstone of E18. It depends on S1–S4 (all builders present) and asserts
their union honors the LOCKED row contract. The four structured primitives are provider-swap-portable;
`rawQuery` is not (S4) — S5's parity proof covers the four structured primitives (rawQuery's output is a
generic column-keyed `QueryResult`, contract-checked in S4's own zip test, not in the fixtures grid).

**Pre-resolved decisions (locked by the epic Notes + E17-S3 review — do NOT re-litigate):**

- **"Byte-identical by construction" = identical row TYPES + identical COMPUTED fields, proven against
  `query-contract.fixtures` (architect, E17-S3 review 2026-07-14).** NOT force-reusing the HTTP nested
  builders. The warehouse builders (S1–S3) produce the same `TrendRow`/`FunnelStepRow`/`RetentionRow`/
  `UniqueCountRow` types with the same `conversionRate`=count[step]/count[0]-guarded and
  periodIndex=0=cohort-period rules; S5 is the executable proof they land on the identical
  `expectedRows`.
- **The row contract is LOCKED** by `planning/QUERY-ROW-CONTRACT.md` + the executable
  `query-contract.fixtures` (mirrored per tree, NOT shared code). S5 produces those rows from SQL-shaped
  inputs; it does not re-decide or edit the shape. — epic Notes.
- **Parity-by-mirror, NOT a shared file.** `ts/.../query/query-contract.fixtures.ts` and
  `python/tests/query_contract_fixtures.py` are mirrors (verbatim wire payloads, expected rows identical
  bar the `conversion_rate`/`period_index` casing renames). A diff between them IS the parity check. S5
  adds each tree's warehouse-side assertion against its own file — do NOT introduce a cross-tree import
  or a single shared fixtures file.
- **Testable against the E17-S3 fake — NO real Postgres.** The SQL-shaped inputs are canned
  `DbExecuteResult`s fed via the fake (TS `createFakeDbExecute` from `db-execute.fixtures`; Python
  `FakeDbExecute` from `db_execute_fakes`) or fed directly to the flat-row builders. E21 does the
  real-Postgres end-to-end proof.

**Reference pointers:**
- Fixtures (the parity target): `ts/packages/node/src/query/query-contract.fixtures.ts` +
  `python/tests/query_contract_fixtures.py` — `WireRowFixture{ description, wireResults, expectedRows }`
  per case; `ENGINE_ROW_FIELD_NAMES` for the seal.
- Row types: `ts/packages/analytics-kit/src/query-result.ts` (`TrendRow`/`UniqueCountRow`/`FunnelStepRow`/
  `RetentionRow`).
- The warehouse builders under proof: S1 (trend/unique_count), S2 (funnel + guarded conversionRate), S3
  (retention + periodIndex=0), all in the S1 SQL-gen module + the warehouse adapter.

## Shipped
