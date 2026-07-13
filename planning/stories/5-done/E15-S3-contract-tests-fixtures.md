---
id: E15-S3-contract-tests-fixtures
epic: E15-QRY-response-row-contract
status: ready-for-dev
area: query
touches: [node]
depends_on: [E15-S2-per-primitive-normalizers]
api_impact: breaking
---

# E15-S3-contract-tests-fixtures — Invert the leak test, seal rows, add per-primitive fixtures

## Why

A test currently PINS the leak as correct pass-through — it must instead assert normalization. This
slice inverts that test, pushes the envelope-seal assertion down to the row level, and adds
wire→neutral-row fixtures that double as the documented contract.

## Scope

### In

- **Invert** the pass-through-pinning test in `ts/packages/node/src/query/http-query-adapter.test.ts`
  (currently named **`normalizeResult passes object entries through when columns are ABSENT
  (insight-object results)`**, at ~line 260 today — locate by name, the line number shifts once S1/S2 land):
  it currently asserts engine-object pass-through is correct; it must now assert the wire insight object is
  **normalized into the neutral row type** for each primitive. Note: this test currently calls
  `normalizeResult(...)` directly with a generic `{label, count}` object; after S2 the per-primitive flatten
  lives behind the primitive methods, so the inverted test asserts against the primitive-method output (or
  the per-primitive normalizer S2 exposes) — not the old shared `normalizeResult` pass-through.
- **Extend the envelope-seal test** (currently named **`the raw vendor envelope shape
  (results/columns/types/hogql/is_cached/kind) appears NOWHERE in the returned value`**, at ~line 238
  today — locate by name) DOWN to the row level: assert the PostHog field names `breakdown_value`,
  `average_conversion_time`, `aggregation_value`, `converted_people_url` appear NOWHERE in the returned rows
  (serialize the full result, not just the envelope keys). There is a SECOND seal test with the same
  serialize-and-assert-absent shape in `http-query-adapter-async.test.ts`
  (**`bar A: the returned value carries ONLY neutral keys — no query_status / results / is_cached leak`**) —
  extend it to the row level too so the async path is sealed at the row level as well as the sync path.
- **Repoint the broken taxonomy-typing type-pins in `query-client.test.ts`.** S1's return-type narrowing
  breaks four `expectTypeOf<AnalyticsQueryClient<never>['<method>']>().returns.toEqualTypeOf<Promise<QueryResult>>()`
  assertions (`funnel`/`retention`/`trend`/`uniqueCount`) — `toEqualTypeOf` is exact-equality and the
  narrowed `QueryResult<FunnelStepRow>` is not equal to the bare `QueryResult`. Repoint each to its narrowed
  row type (`toEqualTypeOf<Promise<QueryResult<FunnelStepRow>>>()`, etc.); `rawQuery` stays on the bare
  `QueryResult`. Optionally tighten the helper-arrow annotations (`const _funnelStepsTypeCheck = ():
  Promise<QueryResult> => ...`) to the narrowed row type in the same file so they assert the narrowing
  rather than mere assignability (they COMPILE either way — this is polish, not a break). — architect
  variance ruling (2026-07-13)
- Add **per-primitive wire-response fixtures** → asserted neutral-row output: one realistic wire insight
  response per structured primitive (`trend`, `uniqueCount`, `funnel`, `retention`), each with its
  expected neutral rows. Cover the `breakdown` case (multiple row-series) for at least trend + funnel.
- These fixtures are the **contract fixtures** the origin feedback asked for — keep them readable and
  self-documenting; S4 references them from the docs.

### Out

- Type/adapter code — S1/S2 (this story only tests them; if a test reveals a code gap, that's an S2
  bug, not new scope here).
- README prose + the language-neutral artifact — S4.
- Optional extras — deferred (epic Out of scope).

## Acceptance criteria

- [ ] The former pass-through-pinning test (`…passes object entries through when columns are ABSENT…`)
      asserts normalization into the neutral row type, not pass-through.
- [ ] The sync seal test (`…the raw vendor envelope shape … appears NOWHERE …`) AND the async seal test
      (`bar A: the returned value carries ONLY neutral keys …`) assert the four engine field names
      (`breakdown_value`, `average_conversion_time`, `aggregation_value`, `converted_people_url`) are absent
      from the serialized returned ROWS (not just the top-level envelope keys).
- [ ] Each of the four primitives has a wire-fixture → neutral-row assertion; breakdown covered for
      trend + funnel.
- [ ] The four broken `query-client.test.ts` `toEqualTypeOf<Promise<QueryResult>>()` return-type pins are
      repointed to the narrowed row types; `rawQuery` stays on the bare `QueryResult`; `query-client.test.ts`
      typechecks green.
- [ ] Full test suite green; neutrality scan green.

## Technical notes

- The existing seal test already checks the envelope keys (`results`/`columns`/`types`/`hogql`/
  `is_cached`/`kind`) are absent — extend the same serialize-and-assert-absent technique to the four
  row-level engine field names. — architect (2026-07-13)
- Capture the wire fixtures from real insight-response shapes (consult `posthog-source-guide` for the
  authoritative shape, or reuse shapes already exercised in the async tests). The fixtures ARE the
  documented contract — S4 points the README/parity artifact at them. — architect (2026-07-13)
- **The fernly `snapshots.test.ts` mocks stay green untouched — do not repoint them.** They feed
  columns-PRESENT envelopes (`{results: cell-arrays, columns: [...]}`), so they exercise S2's UNCHANGED
  `zipRow` (columns-present) branch, not the normalized columns-absent path. Their `{step, count}` /
  `{period, retained}` rows are consumer-mock projections, NOT the neutral per-primitive contract — leave
  them as-is (`touches: [node]` here; the fernly tests are `examples/**` and out of this story's scope).
  The authoritative per-primitive contract fixtures are the NEW node-package fixtures this story adds. If
  those fernly tests go red, something in S1/S2 wrongly touched the columns-present branch — that's an S2
  bug, not an S3 fixture change.
- **`touches` stays `[node]`:** every file this story edits/adds — `http-query-adapter.test.ts`,
  `http-query-adapter-async.test.ts`, `query-client.test.ts`, and the new per-primitive fixtures — lives in
  the node package. Keep the new fixtures in the node query test surface (e.g. alongside
  `http-query-adapter.test.ts`, or a co-located `*.fixtures.ts`) so S4's cross-reference (which points the
  README/parity artifact at "the per-primitive contract fixtures") resolves to a stable node-package path.

> Reviewer suggestion (2026-07-13): `ENGINE_ROW_FIELD_NAMES` lists `aggregation_value` (an epic-named
> engine field), but the trend total the fixtures actually emit is `aggregated_value` (near-homograph),
> asserted absent on a separate line. Add a one-line comment on the constant (or add `aggregated_value`
> to the list) so the next maintainer doesn't read the loop as covering the trend total when it doesn't.
> Reviewer suggestion (2026-07-13): `WireRowFixture<TRow>` exposes a `description` field no test
> consumes — it's intended for S4's docs cross-reference. S4 should either render it in the docs or drop
> it so it doesn't become dead metadata.

## Shipped

> Captured by `implement-epics` on 2026-07-13.

- **Files changed:** `ts/packages/node/src/query/query-client.test.ts` (repointed all 8 broken type-pins — 4 `toEqualTypeOf` return pins to the narrowed rows + 4 helper-arrow annotations; `rawQuery` stays bare), `ts/packages/node/src/query/http-query-adapter.test.ts` (inverted the pass-through test to assert normalization, extended the sync seal to the row level, replaced the stale sync trend fixture, added the CONTRACT tests), `ts/packages/node/src/query/http-query-adapter-async.test.ts` (replaced the 3 stale async cell-array fixtures with realistic insight shapes, extended the async seal to the row level), `ts/examples/fernly/src/kpi/snapshots.test.ts` (swapped the stale HogQL-cell-array funnel/retention/trend mocks for columns-absent insight shapes + repointed assertions to the neutral rows; HogQL/rawQuery columns-present mock left as-is)
- **Files added:** `ts/packages/node/src/query/query-contract.fixtures.ts` — per-primitive wire→neutral-row contract fixtures + `ENGINE_ROW_FIELD_NAMES` (the contract fixtures the origin feedback asked for; S4 points the docs at these)
- **New public API:** none — tests + fixtures only.
- **Tests added:** 8 `CONTRACT …` tests (trend single/breakdown, uniqueCount, funnel plain/zero-first-step/event-precedence/array-of-arrays-breakdown, retention cohorts) covering every reviewer-required case; inverted normalization test; both seal tests extended to row level. Node suite 332 → **340**.
- **Commit:** `main` (message = story title)
- **Reviewer notes:** ship-ready, no critical, first review. **Debt cleared by STRENGTHENING, not weakening** — inverted test asserts normalization (not `.skip`/tautology); both seals extended to the ROW level and made NON-VACUOUS (fed fixtures where `breakdown_value`/`aggregated_value` are genuinely present on the wire, paired with a positive assertion the neutral `breakdown` key surfaced); the 8 type-pins repoint to the EXACT narrowed rows (a widen wouldn't compile); replaced runtime assertions moved from `toHaveLength` to full `toEqual(expectedRows)` deep-equality. Contract fixtures traced against the real normalizer — trend breakdown, funnel per-group conversionRate, `count[0]===0→0` guard, `custom_name→name→action_id` precedence (empty-string skip), retention `periodIndex 0 = cohort` all verified. Fernly fix corrects accidental-green stale fixtures (architect-confirmed the mocks modeled an impossible HogQL-through-structured-primitive shape), fernly SOURCE untouched. No adapter/type/source code changed. Provenance discipline exemplary (one sanctioned `// De-branded from posthog's …` comment). Reviewer ran gates independently: 21/21 turbo, node 340/340, 30/30 neutrality.
- **Retry history:** 1 continuation — the initial pass cleared all node debt but left 3 fernly tests red under S3's original "leave fernly untouched" constraint; the orchestrator authorized the fernly fixture fix (the constraint rested on an architect-refuted premise), and the builder completed it to full green. Not a critical-issue retry — a scope correction.
- **Cross-story seams exposed:** E15's contract is now COMPLETE on the code side (types S1, normalizers S2, tests+fixtures+seal S3, all green). S4 is docs-only: point the README query table + the language-neutral `planning/QUERY-ROW-CONTRACT.md` at `query-contract.fixtures.ts` as the executable contract; state `UniqueCountRow` as its own named concept (S1 reviewer note) so the Python port doesn't collapse it into `TrendRow`; decide the `WireRowFixture.description` field's fate (render or drop).
