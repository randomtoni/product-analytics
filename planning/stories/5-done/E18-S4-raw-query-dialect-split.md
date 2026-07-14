---
id: E18-S4-raw-query-dialect-split
epic: E18-QRY-warehouse-query-primitives
status: ready-for-dev
area: query
touches: [adapters, node]
depends_on: [E18-S1-trend-unique-count-sql]
api_impact: additive
---

# E18-S4-raw-query-dialect-split — `raw_query` passes `expr` to the engine AS SQL; document the SQL-vs-HogQL dialect split

## Why

`rawQuery` is the one deliberate dialect split: the warehouse adapter's dialect is SQL (vs HogQL for the
HTTP adapter). This slice fills the `rawQuery` body — pass `expr` to the engine as SQL via the DB-execute
seam, normalize through the columns-present zip path — and documents that `rawQuery` is the single place
a dialect-keyed shape legitimately surfaces and is therefore **NOT provider-swap-portable**.

## Scope

### In

- Fill the `rawQuery`/`raw_query` body of `WarehouseQueryAdapter` in both trees so it COMPUTES: pass
  `expr` to the injected DB-execute seam AS SQL (no HogQL wrapping, no `kind` discriminator — that is the
  HTTP adapter's wire vocabulary), and normalize the returned `DbExecuteResult` into a `QueryResult`.
- **Normalize through the columns-present zip path.** `DbExecuteResult` carries `rows` (positional
  cells) + `columns` (`{ name, type? }`). Zip each positional row into a column-keyed object via the
  `zipRow`/`_zip_row` helper (`http-query-adapter.ts:395` / `http_adapter.py`) — the SAME helper the
  HTTP adapter uses for its columns-present rawQuery branch, which already expects positional cells (why
  E17-S3 pinned rows-as-arrays-of-arrays). Stamp `columns` (from `DbExecuteResult.columns`) +
  `generatedAt` via the S1 shared assembler; the `columns` on the neutral `QueryResult` carry the
  SELECT's schema so an empty result still reports its shape.
- **Document the SQL-vs-HogQL dialect split** — as a doc note co-located where the `rawQuery` behavior
  is documented (the `rawQuery` method's own dev-facing doc/comment + the self-host recipe surface;
  the exact home settles at implement time, consistent with the existing `rawQuery` framing in E8/E15).
  State precisely:
  - The warehouse adapter's `rawQuery` dialect is **SQL** (Postgres, over `EVENTS_VIEW` / the consumer's
    own schema); the HTTP adapter's is **HogQL**. Same neutral method signature (`rawQuery(expr: string)
    → QueryResult`), different dialect the `expr` string must speak.
  - `rawQuery` is therefore the ONE query primitive that is **NOT provider-swap-portable**: an `expr`
    written for one backend's dialect will not run verbatim on the other. The four structured primitives
    (`funnel`/`retention`/`trend`/`uniqueCount`) ARE provider-swap-portable (they take neutral specs);
    `rawQuery` trades portability for an escape hatch, by design.
  - This is the documented, expected consequence of the dialect split — not a bar-A violation: bar A is
    about the four structured primitives + the neutral row contract, which `rawQuery` still honors on the
    OUTPUT side (it returns a neutral `QueryResult`). Only the INPUT `expr` is dialect-keyed.
- **TS/Python parity:** same pass-`expr`-as-SQL behavior, same columns-present zip normalization, same
  dialect-split documentation in both trees. Unit-test the zip normalization against the E17-S3 fake
  `DbExecute` (canned `DbExecuteResult` with `columns` + positional `rows` → column-keyed neutral rows).

### Out

- `trend`/`unique_count`/`funnel`/`retention` — **S1/S2/S3**. Row-parity proof — **S5**.
- SQL injection hardening / `expr` sanitization — out; `rawQuery` is a deliberate raw escape hatch (the
  consumer owns the `expr`), consistent with the HTTP adapter's rawQuery posture. Do NOT add a sanitizer
  or a parameterization layer here.
- Any seam/config/factory/typed-view change — **E17** (consumed read-only). Real Postgres — **E21**.
- Growing the neutral query interface — anything beyond the four primitives + `rawQuery` stays behind
  `rawQuery`.

## Acceptance criteria

- [ ] `rawQuery`/`raw_query` COMPUTES in both trees: passes `expr` to the injected `DbExecute` seam as
      SQL (no HogQL/`kind` wrapping) and returns a neutral `QueryResult`.
- [ ] Normalization uses the columns-present zip path: positional `DbExecuteResult.rows` are zipped to
      column-keyed objects via `zipRow`/`_zip_row`; `columns` + `generatedAt` are stamped via the S1
      assembler; the neutral `QueryResult.columns` carry the SELECT schema.
- [ ] The SQL-vs-HogQL dialect split is documented, stating that `rawQuery` is NOT provider-swap-portable
      (its `expr` is dialect-keyed) while the four structured primitives are — and that the OUTPUT stays
      a neutral `QueryResult` (bar A intact on output).
- [ ] TS/Python parity on the pass-as-SQL behavior, the zip normalization, and the dialect-split doc;
      tests run against the E17-S3 fake (no real Postgres); both neutrality scans green (the doc names no
      vendor); all gates green in both trees.

## Technical notes

Builds on S1's shared assembler (reuse it) and the existing `zipRow`/`_zip_row` helper. S2/S3/S4 edit
the same adapter file and run sequentially in practice.

**Orchestrator sequencing (story-refiner 2026-07-14):** S2/S3/S4 are dependency-parallel off S1 but all
edit the SAME adapter file in both trees — run them **serially S2 → S3 → S4** (not parallel) to avoid
merge friction. S4 is the lightest of the three (no adversarial SQL — pass-through + zip + a doc note).
Run-ordering recommendation only; the `depends_on` graph is correct as-is.

**Pre-resolved decisions (locked by the epic Notes — do NOT re-litigate):**

- **`rawQuery` is the deliberate dialect split (locked).** SQL dialect (warehouse) vs HogQL (HTTP).
  Document that `rawQuery` is NOT provider-swap-portable — it is the one place a dialect-keyed shape
  legitimately surfaces, consistent with the existing `rawQuery` framing in E8/E15. The warehouse-adapter
  stub already documents this intent (`warehouse-query-adapter.ts` `rawQuery` mapping comment). —
  architect (2026-07-13)
- **Zip path reuses the existing helper.** `DbExecuteResult` rows are positional cells + `columns` —
  exactly what `zipRow`/`_zip_row` (`http-query-adapter.ts:395`) already expects (E17-S3 pinned
  rows-as-arrays-of-arrays specifically so the raw path reuses the zip helper unchanged). Reuse the
  helper; do NOT reimplement zipping. — architect (E17-S3 review 2026-07-14)
- **Column-type adapting at the zip call (code-shape pin, story-refiner 2026-07-14).** The two zip
  helpers take DIFFERENT column arg shapes, and neither is `DbColumn`, so an adapt step is required at
  the call site — do NOT change either helper's signature:
  - **TS** `zipRow(row, columns: string[])` (`http-query-adapter.ts:395`) wants plain column-name
    strings. `DbExecuteResult.columns` is `DbColumn[]` (`{ name, type? }`), so pass
    `result.columns.map((c) => c.name)`.
  - **Python** `_zip_row(row, columns: list[QueryColumn])` (`http_adapter.py:356`) wants neutral
    `QueryColumn`s (it reads `column.name`). `DbExecuteResult.columns` is `list[DbColumn]`, a
    DIFFERENT dataclass, so convert `[QueryColumn(name=c.name, type=c.type) for c in result.columns]`
    (the same `DbColumn`→`QueryColumn` name/type carry-through the S1 assembler already does for the
    neutral `columns` stamp — reuse that mapping, don't duplicate a second one).
  This is the one place `_zip_row` is imported outside `http_adapter.py`; if the builder finds the
  cross-module import awkward, a small warehouse-local `_zip_row` twin over `list[DbColumn]` is an
  acceptable alternative — but keep the SAME positional-cell zip behavior (list → keyed by column
  order; dict → passthrough; else `{}`), asserted against the fixtures in S5's rawQuery-adjacent test.
- **Semantics = documented divergence, NOT byte-exact HogQL parity (user decision).** No PostHog data to
  match; no posthog-source-guide dependency. `rawQuery`'s divergence is the dialect itself, and that
  divergence is the documented, intended behavior.
- **Adapter fills stub against the injected seam — no seam/factory change** (E17-S4). **Testable against
  the E17-S3 fake** — TS `import { createFakeDbExecute } from '../query/db-execute.fixtures'`; Python
  `from db_execute_fakes import FakeDbExecute`. Assert the `expr` reaches the seam verbatim as SQL + the
  columns-present zip normalization against a canned `DbExecuteResult`; **no real Postgres**.

**Reference pointers:**
- HTTP `rawQuery` (the contrast): `http-query-adapter.ts:500` — wraps `expr` in a `HogQLQuery` `kind`;
  `buildRawRows` (`:253`) is the columns-present zip branch to analog on the warehouse side.
- `zipRow` helper: `http-query-adapter.ts:395` (TS) / `_zip_row` (`http_adapter.py`, Python).
- Assembler pattern to reuse from S1: the warehouse `normalizeResult` analog.
- `QueryResult` (`query-result.ts:6-11`): `{ rows, columns, generatedAt, fromCache? }` — the raw path
  populates `columns` from the SELECT schema.

## Shipped

> Captured by `implement-epics` on 2026-07-14.

- **Files changed:** TS `warehouse-sql.ts` (+ warehouse-local `zipRow` twin + `buildRawRows`), `warehouse-query-adapter.ts` (+ `.test.ts`); Python `warehouse_sql.py` (+ `_zip_row` twin + `build_raw_rows`), `warehouse_adapter.py` (+ `tests/test_warehouse_query_adapter.py`)
- **New public API:** none consumer-facing (adapter-internal; reached via `createQueryClient`). All five warehouse primitives now COMPUTE (last stub filled).
- **Tests added:** TS 6 + Python 7 — `expr` reaches the seam verbatim (no `kind`, no `params`), columns-present zip normalization, empty-result-still-reports-schema, neutral `QueryResult` output (bar A on output), zip-twin edge cases (dict passthrough / non-cell → `{}` / short-row trailing None), dialect-split doc names the split + guards `posthog` absent — all against the E17-S3 fake
- **Commit:** this story's ship commit on `main` (see `git log`)
- **Reviewer notes:** independent gate verdict SHIP AS-IS (no criticals, no suggestions). **"HogQL" neutrality ruling: definitively not-a-concern** — `neutrality-scan.ts:184-189` explicitly admits `HogQLQuery` as required wire vocabulary (no vendor *name* token); pre-existing in shipped `src` (S4 echoes in dev `//`/`#` comments, doesn't introduce); the guarded `posthog` token is absent, both scans green
- **Cross-story seams exposed:** `rawQuery` passes `expr` verbatim as SQL (dialect split: warehouse = SQL, HTTP = HogQL); the ONE primitive NOT provider-swap-portable on input (output stays neutral). Warehouse-local zip twin (co-located, HTTP helpers stay private). **S5 (the last E18 story) proves all four structured primitives + the raw path flatten to the locked `query-contract.fixtures`.**
