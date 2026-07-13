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

- **Invert** the test at `ts/packages/node/src/query/http-query-adapter.test.ts:260`
  (`normalizeResult passes object entries through when columns are ABSENT`): it currently asserts
  engine-object pass-through is correct; it must now assert the wire insight object is **normalized into
  the neutral row type** for each primitive.
- **Extend the envelope-seal test** (`http-query-adapter.test.ts:238`) DOWN to the row level: assert the
  PostHog field names `breakdown_value`, `average_conversion_time`, `aggregation_value`,
  `converted_people_url` appear NOWHERE in the returned rows (serialize the full result, not just the
  envelope keys).
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

- [ ] The line-260 test asserts normalization into the neutral row type, not pass-through.
- [ ] The seal test at line 238 asserts the four engine field names are absent from the serialized
      returned rows (not just the top-level envelope).
- [ ] Each of the four primitives has a wire-fixture → neutral-row assertion; breakdown covered for
      trend + funnel.
- [ ] Full test suite green; neutrality scan green.

## Technical notes

- The existing seal test already checks the envelope keys (`results`/`columns`/`types`/`hogql`/
  `is_cached`/`kind`) are absent — extend the same serialize-and-assert-absent technique to the four
  row-level engine field names. — architect (2026-07-13)
- Capture the wire fixtures from real insight-response shapes (consult `posthog-source-guide` for the
  authoritative shape, or reuse shapes already exercised in the async tests). The fixtures ARE the
  documented contract — S4 points the README/parity artifact at them. — architect (2026-07-13)
