---
id: E15-QRY-response-row-contract
status: done
area: query
touches: [node, adapters]
api_impact: breaking
blocked_by: []
updated: 2026-07-13
---

# E15-QRY-response-row-contract — Query read-side: neutral per-primitive row contract

## Why

The read side has a structurally-neutral envelope (`QueryResult`) but **no row contract**: on the
columns-absent branch, `funnel`/`retention`/`trend`/`uniqueCount` pass the backend's insight objects
through AS-IS, leaking engine-internal keys (`breakdown_value`, `average_conversion_time`,
`aggregation_value`, ...) to consumers. This is the root of **two S5-critical bugs** a real consumer
(Tutore) hit — they were forced to guess at undocumented column names. The architect ruled this a
genuine **acceptance-bar-1 leak** (a SQL `WarehouseQueryAdapter` produces different column names,
breaking any consumer keying on `row.breakdown_value`), **not** a docs gap: `posthog-js` has no read
side, so these shapes come from PostHog's server repo where PostHog itself types them as
`Record<string, any>` and its own docs call them "internal… not useful for you." Documenting the
pass-through would promote a vendor-internal field to our public API. The fix is to normalize into a
neutral, documented per-primitive row contract.

## Success criteria

- The four structured primitives return **narrowed, documented neutral rows** — `funnel(): Promise<QueryResult<FunnelStepRow>>`,
  `retention(): Promise<QueryResult<RetentionRow>>`, `trend(): Promise<QueryResult<TrendRow>>`,
  `uniqueCount(): Promise<QueryResult<UniqueCountRow>>` — with no engine-internal keys anywhere in the
  returned rows.
- `QueryResult<TRow = Record<string, unknown>>` is a generic envelope; `rawQuery` keeps the default
  `Record<string, unknown>` and is **documented as verbatim column-keyed pass-through** (the consumer's
  own SELECT projection — the one place a dialect-keyed shape legitimately surfaces).
- **Bar A re-proven at the row level:** the neutral row contract is backend-agnostic — a SQL warehouse
  backend can populate the same `TrendRow`/`FunnelStepRow`/`RetentionRow`/`UniqueCountRow` from a
  `GROUP BY` with **zero consumer change**. Any consumer keying on the documented neutral fields
  survives a provider swap.
- **Bar B intact:** normalization is entirely adapter-internal; a new consumer wires the four
  primitives by config only, zero library change.
- The envelope-seal test extends **down to the row level**: PostHog field names (`breakdown_value`,
  `average_conversion_time`, `aggregation_value`, `converted_people_url`) appear nowhere in returned
  rows.
- A **language-neutral contract artifact** in `planning/` states the per-primitive field set as the
  shared contract the Python query client ports TO (parity by shared contract, not shared code).
- All TS gates green (build · test · typecheck · lint) + neutrality scan; the inverted/extended tests
  pass on per-primitive wire fixtures.

## Stories

- **[E15-S1](../stories/5-done/E15-S1-neutral-row-types.md)** *(done — `ba3880b`)* — define the four neutral row types + generic `QueryResult<TRow>` envelope in the seam; narrow the four `AnalyticsQueryClient` primitive return types; `rawQuery` keeps the default.
- **[E15-S2](../stories/5-done/E15-S2-per-primitive-normalizers.md)** *(done — `5e8195b`)* — split `normalizeResult`'s columns-absent branch into per-primitive normalizers in `http-query-adapter.ts`; each method flattens its wire insight shape into its neutral row type; the columns-present (`rawQuery`) branch is untouched.
- **[E15-S3](../stories/5-done/E15-S3-contract-tests-fixtures.md)** *(done — `e00e528`)* — invert the pass-through-pinning test to assert normalization; extend the envelope-seal assertion down to the row level; add per-primitive wire→neutral-row fixtures (the fixtures double as the documented contract).
- **[E15-S4](../stories/5-done/E15-S4-contract-docs-parity-artifact.md)** *(done — `52b26ae`)* — document the per-primitive row shapes in the TS README query table; write the language-neutral `planning/` contract artifact the Python query client ports to.

**Shipped:** all four stories green end-to-end (21/21 turbo + 30/30 neutrality). The columns-absent leak is structurally closed — the four structured primitives return documented neutral rows (`TrendRow`/`UniqueCountRow`/`FunnelStepRow`/`RetentionRow`), the row-level seal test proves no engine key survives, `rawQuery` keeps documented verbatim pass-through, and `planning/QUERY-ROW-CONTRACT.md` is the standing parity artifact for the Python query cycle. Breaking → anchors the pre-1.0 0.2.0 bump (decided at cycle close; Tutore cutover coordinated by the user).

## Out of scope

- **Optional timing/total extras** — funnel `medianConversionTime`, a trend series total (`aggregated`).
  **DECISION (PM): deferred to a non-breaking fast-follow, not in this epic.** The architect flagged
  this scope call as mine: the core rows are non-negotiable for capability-completeness (they close the
  leak), but the extras are **additive** — adding an optional field to a row never breaks a consumer, so
  they need not ride the breaking release. Deferring keeps this epic a tight, single-purpose
  contract-establishing break; the extras land later against the BRIEF's funnel/trend contract with zero
  migration cost, in their own additive `query` epic. Bundling them would widen a breaking-fix window and
  dilute the "replace no-contract with a contract" framing.
- **Warehouse adapter SQL fill-in** — E8-S5 stays a stub; this epic only proves the row contract is
  backend-agnostic, it does not implement the SQL backend.
- **Growing the neutral query interface** beyond the four primitives + `rawQuery` — anything else stays
  behind `rawQuery`. We are firming the row shape of the existing primitives, not adding new ones.
- **The Python implementation of the row contract** — this epic writes the shared contract artifact the
  Python query client ports to; the port itself lands in the Python query cycle (parity obligation, noted
  below), not here.
- **Dashboards / charts / any visualization** — consumer territory.

## Notes

- **Genuine bar-A neutrality leak, not a docs gap — the decisive grounding.** `posthog-js` has NO read
  side; the leaked insight shapes live in PostHog's server repo, where PostHog itself types them as
  `any`/`Record<string, any>` and its docs call them "internal… not useful for you." The current
  pass-through forwards a shape the upstream explicitly disclaims; documenting it would promote a
  vendor-internal field to our public API. The only bar-A-satisfying fix is normalization into a neutral
  row contract. — architect (2026-07-13)
- **The leak is exactly the columns-absent branch.** `normalizeResult` (`ts/packages/node/src/query/http-query-adapter.ts`
  ~line 205) has two branches: columns-PRESENT (cell arrays zipped by the engine's own SELECT column
  names — this is `rawQuery`, and it is **fine**; those columns are the consumer's own projection) and
  columns-ABSENT (`trend`/`funnel`/`retention`/`uniqueCount` insight objects pass through with
  engine-internal keys + empty `columns`). Only the columns-absent branch is normalized; the
  columns-present branch is left untouched. — architect (2026-07-13)
- **Per-primitive neutral row contract (the epic's target shape):**
  - `TrendRow { bucket, value, breakdown? }`
  - `UniqueCountRow` — same shape as `TrendRow` (it is a trend with dau math)
  - `FunnelStepRow { step, event, count, conversionRate, breakdown? }`
  - `RetentionRow { cohort, periodIndex, value, breakdown? }`
  Each normalizer **flattens** PostHog's nested/parallel-array insight structures to **one row per data
  cell** — neutral, lossless on the real data, native to a SQL `GROUP BY` backend, cleanly
  Python-portable. — architect (2026-07-13)
- **Generic envelope, narrowed primitives.** `QueryResult<TRow = Record<string, unknown>>`; the four
  primitives narrow `TRow` to their row type, `rawQuery` keeps the default (verbatim column-keyed
  pass-through, documented as such). — architect (2026-07-13)
- **Breaking change → ship as a pre-1.0 breaking minor (0.2.0).** Tutore consumes the published 0.1.0.
  **No compat shim** — a shim would re-leak the very fields we are removing. This is the
  contract-establishing release: it replaces no-contract with a contract, breaking only fragile code that
  was already guessing. Version is decided at cycle close (this is the sole API impact in flight); the
  bump reasoning is recorded here, not as a roadmap label. — architect (2026-07-13)
- **Tutore coordination.** Tutore is the single known consumer and the source of the two S5 criticals —
  the cheapest possible moment to make this break. Coordinate the cutover with them; the neutral rows
  give them stable keys to migrate their two broken code paths onto.
- **Parity obligation.** This creates a contract the Python query client MUST mirror when the Python
  query cycle lands. The language-neutral artifact (S4) is the shared source of truth: field concepts
  `bucket`, `value`, `breakdown`, `step`, `event`, `count`, `conversionRate`, `cohort`, `periodIndex` —
  each language cases idiomatically (TS camelCase, Python snake_case).

## Expansion path

The optional timing/total extras (funnel `medianConversionTime`, trend `aggregated`) land as an additive
fast-follow — new optional fields on the existing rows, zero migration. A future SQL warehouse backend
populates the SAME neutral rows from a `GROUP BY`, proving the row contract is backend-agnostic (bar A) —
one adapter, zero consumer change. Growth stays additive on the row types; `rawQuery` remains the only
dialect-keyed surface.
