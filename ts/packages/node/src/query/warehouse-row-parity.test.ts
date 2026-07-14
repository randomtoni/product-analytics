import type { ShapeOf } from '@randomtoni/analytics-kit';
import { defineTaxonomy } from '@randomtoni/analytics-kit';
import { expect, test } from 'vitest';
import type { DbExecuteResult } from './db-execute';
import { createFakeDbExecute } from './db-execute.fixtures';
import {
  ENGINE_ROW_FIELD_NAMES,
  funnelBreakdown,
  funnelEventPrecedence,
  funnelPlain,
  funnelZeroFirstStep,
  retentionCohorts,
  trendBreakdown,
  trendSingleSeries,
  uniqueCountSingleSeries,
} from './query-contract.fixtures';
import { createWarehouseQueryAdapter } from './warehouse-query-adapter';

// E18-S5 — the bar-A READ-SIDE capstone, made executable. The whole epic exists to re-prove bar A
// at the row level: the warehouse adapter must return the SAME neutral rows as the HTTP adapter, so
// any consumer keying on them survives the provider swap. This suite is that proof — it drives the
// S1–S4 warehouse builders (via the adapter, through the injected DB-execute seam) with a
// SQL-shaped canned `DbExecuteResult` per fixture and asserts the produced neutral rows EQUAL the
// `expectedRows` of the matching `query-contract.fixtures` case.
//
// The fixtures' `wireResults` are HTTP-engine-nested (parallel `days`/`data`, per-step objects,
// cohort `values` arrays) — NOT the warehouse's flat SQL shape. So each SQL-shaped input below is
// the FLAT `DbExecuteResult` a warehouse SELECT would return for the SAME scenario, authored here;
// the assertion is that the warehouse builder flattens it to the SAME `expectedRows` the HTTP
// adapter's nested normalizer produces. The parity target is `expectedRows` (already identical
// across both trees' fixtures files); this story adds the warehouse-side assertion. The mirrored
// Python suite lives at `python/tests/test_warehouse_row_parity.py`, cell-for-cell.
//
// The fixtures are consumed READ-ONLY — never edited. If a warehouse builder could not reproduce a
// fixture's `expectedRows`, that would be a BUG in the S1–S3 builder, fixed there, never by
// relaxing the fixture. (They ship green, so it holds.)

// A runtime taxonomy the breakdown specs narrow AND validate against — the declared-key set the
// SQL-gen guard checks a `breakdown` key against (E21-S5). `plan` is a declared `string` event prop
// (the string-keyed breakdown fixtures) and `amount` a declared `number` prop (the number-keyed
// fixture, proving the row-builder stringifies a numeric cell to `'42'`). The funnel-precedence
// case's OUTPUT `event` values are spec-sourced, so the resolved identities (`'Renamed Step'`/
// `'act_3'`) are declared events to be valid `spec.steps` keys.
const taxonomy = defineTaxonomy({
  events: {
    order_placed: { plan: 'string', amount: 'number' },
    signed_up: { plan: 'string', amount: 'number' },
    document_uploaded: {},
    active_reviewers: {},
    'Renamed Step': {},
    act_3: {},
  },
  traits: { plan: 'string' },
});

type TX = ShapeOf<(typeof taxonomy)['decl']>;

// Build an adapter over a fake DB-execute that returns exactly the given SQL-shaped result. The
// taxonomy is supplied so the broken-down parity cases pass the declared-key guard.
function adapterReturning(result: DbExecuteResult) {
  const fake = createFakeDbExecute(result);
  return createWarehouseQueryAdapter<TX>({ dbExecute: fake.execute, taxonomy });
}

// ── SQL-shaped inputs (the flat rows a warehouse SELECT would return per scenario) ───────────
// Each carries the driver-reported `columns` schema + positional cells the S1–S3 flat-row builders
// read by column name (`bucket`/`value`/`breakdown`; `step_index`/`event_name`/`actor_count`;
// `cohort`/`period_index`/`value`). The event names in a funnel result's `event_name` column echo
// the spec steps but are NOT the neutral source of truth (the builder sources `event` from
// `spec.steps`) — except `funnelEventPrecedence`, called out below.

// TREND single series → trendSingleSeries.expectedRows (one row per bucket).
const trendSingleSql: DbExecuteResult = {
  columns: [
    { name: 'bucket', type: 'text' },
    { name: 'value', type: 'int8' },
  ],
  rows: [
    ['2026-07-01', 12],
    ['2026-07-02', 30],
    ['2026-07-03', 7],
  ],
};

// TREND breakdown → trendBreakdown.expectedRows (a `breakdown` cell per row, one series per value).
const trendBreakdownSql: DbExecuteResult = {
  columns: [{ name: 'bucket' }, { name: 'value' }, { name: 'breakdown' }],
  rows: [
    ['2026-07-01', 8, 'pro'],
    ['2026-07-02', 20, 'pro'],
    ['2026-07-01', 4, 'free'],
    ['2026-07-02', 10, 'free'],
  ],
};

// TREND number-keyed breakdown (E21-S5 §4c half (1)) → the row-builder stringifies a NUMERIC cell.
// A FAKE `DbExecuteResult` echoes whatever cell you seed (the fake never runs the `::text` cast), so
// this HALF proves the neutral-row STRINGIFICATION: a numeric `42` cell becomes the exact string
// `'42'` (never `'42.0'`, never a `Number`/`Decimal` repr) cross-tree. HALF (2) — that Postgres
// `numeric::text` renders `'42'` end-to-end through the real cast — lives in the real-PG scenario.
const trendNumberBreakdownSql: DbExecuteResult = {
  columns: [{ name: 'bucket' }, { name: 'value' }, { name: 'breakdown' }],
  rows: [
    ['2026-07-01', 8, 42],
    ['2026-07-02', 20, 42],
    ['2026-07-01', 4, 7],
  ],
};

// UNIQUE COUNT → uniqueCountSingleSeries.expectedRows (same flat bucket/value shape as trend).
const uniqueCountSql: DbExecuteResult = {
  columns: [{ name: 'bucket' }, { name: 'value' }],
  rows: [
    ['2026-07-01', 140],
    ['2026-07-02', 165],
  ],
};

// FUNNEL plain → funnelPlain.expectedRows. The SQL yields (step_index, event_name, actor_count) per
// step; conversionRate is COMPUTED in the builder (count[step]/count[0]).
const funnelPlainSql: DbExecuteResult = {
  columns: [
    { name: 'step_index', type: 'int4' },
    { name: 'event_name', type: 'text' },
    { name: 'actor_count', type: 'int8' },
  ],
  rows: [
    [0, 'signed_up', 1000],
    [1, 'order_placed', 620],
    [2, 'document_uploaded', 410],
  ],
};

// FUNNEL zero-first-step → funnelZeroFirstStep.expectedRows. GUARD-CRITICAL: count[0] === 0 ⇒
// conversionRate 0 on every step (guarded division, no NaN/Infinity leak) — computed from these SQL
// counts identically to the HTTP fixture's `expectedRows`.
const funnelZeroFirstStepSql: DbExecuteResult = {
  columns: [{ name: 'step_index' }, { name: 'event_name' }, { name: 'actor_count' }],
  rows: [
    [0, 'signed_up', 0],
    [1, 'order_placed', 0],
  ],
};

// FUNNEL event precedence → funnelEventPrecedence.expectedRows. NOTE: the warehouse has NO
// `custom_name → name → action_id` wire precedence — per S2, its funnel `event` is the step's own
// identity (sourced from `spec.steps`). So this SQL-shaped input supplies each step's `event_name`
// column ALREADY carrying the RESOLVED identity the fixture's `expectedRows` expect (`'Renamed
// Step'`/`'order_placed'`/`'act_3'`), and the funnel spec's `steps` carry those same resolved
// names, which the builder passes through. The parity claim here is on the OUTPUT `event` values —
// NOT that the warehouse re-derives them via the HTTP precedence rule (it cannot, and does not need
// to; the row contract fixes the OUTPUT, not the derivation path).
const funnelEventPrecedenceSql: DbExecuteResult = {
  columns: [{ name: 'step_index' }, { name: 'event_name' }, { name: 'actor_count' }],
  rows: [
    [0, 'Renamed Step', 500],
    [1, 'order_placed', 250],
    [2, 'act_3', 100],
  ],
};

// FUNNEL breakdown → funnelBreakdown.expectedRows. One (step_index, event_name, actor_count,
// breakdown) row per (group, step); conversionRate is per-GROUP (each group's count[0] is that
// group's first step).
const funnelBreakdownSql: DbExecuteResult = {
  columns: [
    { name: 'step_index' },
    { name: 'event_name' },
    { name: 'actor_count' },
    { name: 'breakdown' },
  ],
  rows: [
    [0, 'signed_up', 800, 'pro'],
    [1, 'order_placed', 400, 'pro'],
    [0, 'signed_up', 200, 'free'],
    [1, 'order_placed', 50, 'free'],
  ],
};

// RETENTION → retentionCohorts.expectedRows. One dense (cohort, period_index, value) cell per row.
// GUARD-CRITICAL: period_index 0 = the cohort's OWN period (the base cohort size), sourced straight
// from the flat cells — identical to the HTTP fixture's `expectedRows`.
const retentionSql: DbExecuteResult = {
  columns: [
    { name: 'cohort', type: 'text' },
    { name: 'period_index', type: 'int4' },
    { name: 'value', type: 'int8' },
  ],
  rows: [
    ['2026-07-01', 0, 500],
    ['2026-07-01', 1, 310],
    ['2026-07-01', 2, 190],
    ['2026-07-08', 0, 420],
    ['2026-07-08', 1, 250],
    ['2026-07-08', 2, 150],
  ],
};

// ── Row-parity: warehouse-produced rows EQUAL the fixture's expectedRows ──────────────────────

test('PARITY trend, single series → warehouse rows equal trendSingleSeries.expectedRows', async () => {
  const result = await adapterReturning(trendSingleSql).trend({
    event: 'order_placed',
    aggregation: 'total',
    window: { value: 7, unit: 'day' },
  });
  expect(result.rows).toEqual(trendSingleSeries.expectedRows);
});

test('PARITY trend, breakdown → warehouse rows equal trendBreakdown.expectedRows', async () => {
  const result = await adapterReturning(trendBreakdownSql).trend({
    event: 'order_placed',
    aggregation: 'total',
    window: { value: 7, unit: 'day' },
    breakdown: 'plan',
  });
  expect(result.rows).toEqual(trendBreakdown.expectedRows);
});

test('NUMBER-KEYED breakdown (§4c half 1): the row-builder stringifies a numeric cell to the exact string "42"', async () => {
  const result = await adapterReturning(trendNumberBreakdownSql).trend({
    event: 'order_placed',
    aggregation: 'total',
    window: { value: 7, unit: 'day' },
    breakdown: 'amount',
  });
  // Every breakdown value is the exact String(cell) — `42` → `'42'`, never `'42.0'`/a Number repr.
  expect(result.rows).toEqual([
    { bucket: '2026-07-01', value: 8, breakdown: '42' },
    { bucket: '2026-07-02', value: 20, breakdown: '42' },
    { bucket: '2026-07-01', value: 4, breakdown: '7' },
  ]);
  for (const row of result.rows) {
    expect(typeof row.breakdown).toBe('string');
  }
});

test('PARITY uniqueCount → warehouse rows equal uniqueCountSingleSeries.expectedRows', async () => {
  const result = await adapterReturning(uniqueCountSql).uniqueCount({
    event: 'active_reviewers',
    window: { value: 7, unit: 'day' },
  });
  expect(result.rows).toEqual(uniqueCountSingleSeries.expectedRows);
});

test('PARITY funnel, plain → warehouse rows equal funnelPlain.expectedRows (computed conversionRate)', async () => {
  const result = await adapterReturning(funnelPlainSql).funnel({
    steps: ['signed_up', 'order_placed', 'document_uploaded'],
    within: { value: 7, unit: 'day' },
  });
  expect(result.rows).toEqual(funnelPlain.expectedRows);
});

test('PARITY funnel, count[0] === 0 → warehouse rows equal funnelZeroFirstStep.expectedRows (guarded ⇒ 0)', async () => {
  const result = await adapterReturning(funnelZeroFirstStepSql).funnel({
    steps: ['signed_up', 'order_placed'],
    within: { value: 7, unit: 'day' },
  });
  expect(result.rows).toEqual(funnelZeroFirstStep.expectedRows);
});

test('PARITY funnel, event precedence → warehouse OUTPUT event equals funnelEventPrecedence.expectedRows (spec-sourced, not the wire walk)', async () => {
  // The warehouse funnel `event` is spec-sourced (S2), so the spec's `steps` carry the SAME
  // resolved identities the fixture's `expectedRows` expect — the builder passes them through.
  // The parity claim is on the OUTPUT `event` values, NOT re-deriving via the HTTP precedence rule.
  const result = await adapterReturning(funnelEventPrecedenceSql).funnel({
    steps: ['Renamed Step', 'order_placed', 'act_3'],
    within: { value: 7, unit: 'day' },
  });
  expect(result.rows).toEqual(funnelEventPrecedence.expectedRows);
  expect(result.rows.map((row) => row.event)).toEqual(
    funnelEventPrecedence.expectedRows.map((row) => row.event)
  );
});

test('PARITY funnel, breakdown → warehouse rows equal funnelBreakdown.expectedRows (per-group conversionRate)', async () => {
  const result = await adapterReturning(funnelBreakdownSql).funnel({
    steps: ['signed_up', 'order_placed'],
    within: { value: 7, unit: 'day' },
    breakdown: 'plan',
  });
  expect(result.rows).toEqual(funnelBreakdown.expectedRows);
});

test('PARITY retention → warehouse rows equal retentionCohorts.expectedRows (periodIndex 0 = the cohort)', async () => {
  const result = await adapterReturning(retentionSql).retention({
    cohortEvent: 'signed_up',
    returnEvent: 'order_placed',
    periods: 3,
    granularity: 'week',
  });
  expect(result.rows).toEqual(retentionCohorts.expectedRows);
});

// ── Computed-field parity, asserted concretely (bar-A "byte-identical by construction") ───────

test('COMPUTED conversionRate (guarded): count[0] === 0 ⇒ 0 on every step, matching the HTTP fixture values', async () => {
  const result = await adapterReturning(funnelZeroFirstStepSql).funnel({
    steps: ['signed_up', 'order_placed'],
    within: { value: 7, unit: 'day' },
  });
  // The guard produces 0 (never NaN/Infinity) from SQL counts, exactly as the HTTP fixture.
  expect(result.rows.map((row) => row.conversionRate)).toEqual(
    funnelZeroFirstStep.expectedRows.map((row) => row.conversionRate)
  );
  expect(result.rows.map((row) => row.conversionRate)).toEqual([0, 0]);
});

test('COMPUTED conversionRate (normal + per-group): SQL counts divide to the same ratios as the HTTP fixtures', async () => {
  const plain = await adapterReturning(funnelPlainSql).funnel({
    steps: ['signed_up', 'order_placed', 'document_uploaded'],
    within: { value: 7, unit: 'day' },
  });
  expect(plain.rows.map((row) => row.conversionRate)).toEqual(
    funnelPlain.expectedRows.map((row) => row.conversionRate)
  );
  expect(plain.rows.map((row) => row.conversionRate)).toEqual([1, 0.62, 0.41]);

  const grouped = await adapterReturning(funnelBreakdownSql).funnel({
    steps: ['signed_up', 'order_placed'],
    within: { value: 7, unit: 'day' },
    breakdown: 'plan',
  });
  expect(grouped.rows.map((row) => [row.conversionRate, row.breakdown])).toEqual(
    funnelBreakdown.expectedRows.map((row) => [row.conversionRate, row.breakdown])
  );
});

test('COMPUTED periodIndex 0 = the cohort period: the base-cohort cell matches the HTTP fixture value', async () => {
  const result = await adapterReturning(retentionSql).retention({
    cohortEvent: 'signed_up',
    returnEvent: 'order_placed',
    periods: 3,
    granularity: 'week',
  });
  expect(result.rows.map((row) => row.periodIndex)).toEqual(
    retentionCohorts.expectedRows.map((row) => row.periodIndex)
  );
  expect(result.rows.map((row) => row.periodIndex)).toEqual([0, 1, 2, 0, 1, 2]);
  // The offset-0 cells are the cohorts' own base sizes (500, 420) — sourced from SQL counts,
  // identical to the fixture.
  const baseCells = result.rows.filter((row) => row.periodIndex === 0).map((row) => row.value);
  expect(baseCells).toEqual([500, 420]);
});

// ── Seal (leak guard): no ENGINE_ROW_FIELD_NAMES token on any warehouse-produced row ──────────
// The warehouse never speaks the engine wire, so this holds trivially — asserted anyway so a future
// regression (e.g. a leaked SQL column alias) fails this gate. Covers BOTH paths: the broken-down
// inputs (the ones most likely to leak a `breakdown_value`-style token) AND a plain (non-breakdown)
// output per primitive — the builders share one code path, so sealing both is a completeness nicety.

test('SEAL: no ENGINE_ROW_FIELD_NAMES token appears on any warehouse-produced row (breakdown + plain paths)', async () => {
  const trend = await adapterReturning(trendBreakdownSql).trend({
    event: 'order_placed',
    aggregation: 'total',
    window: { value: 7, unit: 'day' },
    breakdown: 'plan',
  });
  const funnel = await adapterReturning(funnelBreakdownSql).funnel({
    steps: ['signed_up', 'order_placed'],
    within: { value: 7, unit: 'day' },
    breakdown: 'plan',
  });
  const retention = await adapterReturning(retentionSql).retention({
    cohortEvent: 'signed_up',
    returnEvent: 'order_placed',
    periods: 3,
    granularity: 'week',
  });

  // Plain (non-breakdown) outputs — the same shared builder path, exercised without a breakdown.
  const trendPlain = await adapterReturning(trendSingleSql).trend({
    event: 'order_placed',
    aggregation: 'total',
    window: { value: 7, unit: 'day' },
  });
  const funnelPlain_ = await adapterReturning(funnelPlainSql).funnel({
    steps: ['signed_up', 'order_placed', 'document_uploaded'],
    within: { value: 7, unit: 'day' },
  });
  const retentionPlain = await adapterReturning(retentionSql).retention({
    cohortEvent: 'signed_up',
    returnEvent: 'order_placed',
    periods: 3,
    granularity: 'week',
  });

  for (const rows of [
    trend.rows,
    funnel.rows,
    retention.rows,
    trendPlain.rows,
    funnelPlain_.rows,
    retentionPlain.rows,
  ]) {
    const serialized = JSON.stringify(rows);
    for (const field of ENGINE_ROW_FIELD_NAMES) {
      expect(serialized).not.toContain(field);
    }
  }
});
