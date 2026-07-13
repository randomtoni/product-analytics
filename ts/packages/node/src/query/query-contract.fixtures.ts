import type { FunnelStepRow, RetentionRow, TrendRow } from '@randomtoni/analytics-kit';

// The per-primitive wire→neutral-row CONTRACT fixtures. Each fixture pairs a realistic
// backend insight-response `results` payload (the columns-ABSENT branch — engine-internal,
// vendor-shaped, carrying keys like `breakdown_value`/`average_conversion_time` the neutral
// surface must NOT leak) with the exact neutral rows the adapter's per-primitive normalizer
// must produce. These fixtures ARE the documented contract the Python query client ports to
// (S4 points the README/parity artifact here) — keep them readable and self-documenting.
//
// Shapes are de-branded from posthog's insight-response payloads: trend entries carry
// parallel `days`/`data` arrays; funnel results are per-step objects (an array-of-arrays
// when broken down); retention results are cohort objects with an indexed `values` array.
// `columns`/`types` are HogQL/rawQuery-only and are deliberately ABSENT on every fixture
// here — these are the structured insight objects, not a SELECT projection.

export interface WireRowFixture<TRow> {
  readonly description: string;
  // The `results` array exactly as the backend returns it on the columns-absent branch.
  readonly wireResults: unknown[];
  readonly expectedRows: ReadonlyArray<TRow>;
}

// ── TREND ────────────────────────────────────────────────────────────────────
// Single series: one top-level entry with parallel `days[]`/`data[]`, one neutral
// row per bucket. `label`/`count`/`aggregated_value` on the wire never surface.

export const trendSingleSeries: WireRowFixture<TrendRow> = {
  description: 'trend, single series → one row per (bucket, value)',
  wireResults: [
    {
      label: 'order_placed',
      days: ['2026-07-01', '2026-07-02', '2026-07-03'],
      data: [12, 30, 7],
      count: 49,
      aggregated_value: 49,
    },
  ],
  expectedRows: [
    { bucket: '2026-07-01', value: 12 },
    { bucket: '2026-07-02', value: 30 },
    { bucket: '2026-07-03', value: 7 },
  ],
};

// Broken-down: one top-level series PER breakdown value, each with its own days/data and a
// `breakdown_value` — flattened to one row-series per breakdown, the breakdown stringified
// onto every row. The engine-internal `breakdown_value` key must appear on NO neutral row.

export const trendBreakdown: WireRowFixture<TrendRow> = {
  description: 'trend, breakdown → one row-series per breakdown_value, breakdown on each row',
  wireResults: [
    {
      label: 'order_placed - pro',
      breakdown_value: 'pro',
      days: ['2026-07-01', '2026-07-02'],
      data: [8, 20],
    },
    {
      label: 'order_placed - free',
      breakdown_value: 'free',
      days: ['2026-07-01', '2026-07-02'],
      data: [4, 10],
    },
  ],
  expectedRows: [
    { bucket: '2026-07-01', value: 8, breakdown: 'pro' },
    { bucket: '2026-07-02', value: 20, breakdown: 'pro' },
    { bucket: '2026-07-01', value: 4, breakdown: 'free' },
    { bucket: '2026-07-02', value: 10, breakdown: 'free' },
  ],
};

// ── UNIQUE COUNT ─────────────────────────────────────────────────────────────
// uniqueCount is byte-identical to trend on the wire (same days/data; only the
// server-side math differs) — it shares the trend row shape and normalizer.

export const uniqueCountSingleSeries: WireRowFixture<TrendRow> = {
  description: 'uniqueCount, single series → same days/data shape as trend',
  wireResults: [
    {
      label: 'active reviewers',
      days: ['2026-07-01', '2026-07-02'],
      data: [140, 165],
    },
  ],
  expectedRows: [
    { bucket: '2026-07-01', value: 140 },
    { bucket: '2026-07-02', value: 165 },
  ],
};

// ── FUNNEL ───────────────────────────────────────────────────────────────────
// Plain funnel: a flat step array. `conversionRate` is COMPUTED (count[step]/count[0]),
// NOT a wire field. Event identity resolves via `custom_name → name → action_id` (first
// present non-empty). `average_conversion_time`/`converted_people_url` never surface.

export const funnelPlain: WireRowFixture<FunnelStepRow> = {
  description: 'funnel, plain → step rows with computed conversionRate (count/count[0])',
  wireResults: [
    { order: 0, name: 'signed_up', count: 1000, average_conversion_time: null, converted_people_url: '/x/0' },
    { order: 1, name: 'order_placed', count: 620, average_conversion_time: 3600, converted_people_url: '/x/1' },
    { order: 2, name: 'document_uploaded', count: 410, average_conversion_time: 7200, converted_people_url: '/x/2' },
  ],
  expectedRows: [
    { step: 0, event: 'signed_up', count: 1000, conversionRate: 1 },
    { step: 1, event: 'order_placed', count: 620, conversionRate: 0.62 },
    { step: 2, event: 'document_uploaded', count: 410, conversionRate: 0.41 },
  ],
};

// count[0] === 0 → conversionRate 0 for every step (guarded division, no NaN/Infinity leak).

export const funnelZeroFirstStep: WireRowFixture<FunnelStepRow> = {
  description: 'funnel, count[0] === 0 → conversionRate 0 on every step (guarded)',
  wireResults: [
    { order: 0, name: 'signed_up', count: 0 },
    { order: 1, name: 'order_placed', count: 0 },
  ],
  expectedRows: [
    { step: 0, event: 'signed_up', count: 0, conversionRate: 0 },
    { step: 1, event: 'order_placed', count: 0, conversionRate: 0 },
  ],
};

// Event-identity precedence: custom_name wins over name wins over action_id; the first
// present NON-EMPTY string is the neutral `event`.

export const funnelEventPrecedence: WireRowFixture<FunnelStepRow> = {
  description: 'funnel, event precedence custom_name → name → action_id (first non-empty)',
  wireResults: [
    { order: 0, custom_name: 'Renamed Step', name: 'signed_up', action_id: 'act_1', count: 500 },
    { order: 1, custom_name: '', name: 'order_placed', action_id: 'act_2', count: 250 },
    { order: 2, name: '', action_id: 'act_3', count: 100 },
  ],
  expectedRows: [
    { step: 0, event: 'Renamed Step', count: 500, conversionRate: 1 },
    { step: 1, event: 'order_placed', count: 250, conversionRate: 0.5 },
    { step: 2, event: 'act_3', count: 100, conversionRate: 0.2 },
  ],
};

// Broken-down funnel: an ARRAY OF ARRAYS — one inner step-array per breakdown group, each
// step carrying `breakdown_value`. conversionRate is per-GROUP (each group's count[0] is
// that group's first step), and the breakdown is stringified onto every row.

export const funnelBreakdown: WireRowFixture<FunnelStepRow> = {
  description: 'funnel, array-of-arrays breakdown → per-group conversionRate + breakdown on each row',
  wireResults: [
    [
      { order: 0, name: 'signed_up', count: 800, breakdown_value: 'pro' },
      { order: 1, name: 'order_placed', count: 400, breakdown_value: 'pro' },
    ],
    [
      { order: 0, name: 'signed_up', count: 200, breakdown_value: 'free' },
      { order: 1, name: 'order_placed', count: 50, breakdown_value: 'free' },
    ],
  ],
  expectedRows: [
    { step: 0, event: 'signed_up', count: 800, conversionRate: 1, breakdown: 'pro' },
    { step: 1, event: 'order_placed', count: 400, conversionRate: 0.5, breakdown: 'pro' },
    { step: 0, event: 'signed_up', count: 200, conversionRate: 1, breakdown: 'free' },
    { step: 1, event: 'order_placed', count: 50, conversionRate: 0.25, breakdown: 'free' },
  ],
};

// ── RETENTION ────────────────────────────────────────────────────────────────
// Cohort objects, each with `date` (cohort start) and an indexed `values` array where
// index 0 is the cohort itself (periodIndex 0 = the cohort's own period). One neutral row
// per (cohort, period) cell.

export const retentionCohorts: WireRowFixture<RetentionRow> = {
  description: 'retention → one row per (cohort, periodIndex); periodIndex 0 = the cohort itself',
  wireResults: [
    {
      date: '2026-07-01',
      label: 'Week 0',
      values: [{ count: 500 }, { count: 310 }, { count: 190 }],
    },
    {
      date: '2026-07-08',
      label: 'Week 1',
      values: [{ count: 420 }, { count: 250 }, { count: 150 }],
    },
  ],
  expectedRows: [
    { cohort: '2026-07-01', periodIndex: 0, value: 500 },
    { cohort: '2026-07-01', periodIndex: 1, value: 310 },
    { cohort: '2026-07-01', periodIndex: 2, value: 190 },
    { cohort: '2026-07-08', periodIndex: 0, value: 420 },
    { cohort: '2026-07-08', periodIndex: 1, value: 250 },
    { cohort: '2026-07-08', periodIndex: 2, value: 150 },
  ],
};

// The engine-internal ROW field names a neutral row must NEVER carry. The seal tests
// serialize the returned rows and assert each of these is absent from the wire.
export const ENGINE_ROW_FIELD_NAMES = [
  'breakdown_value',
  'average_conversion_time',
  'aggregation_value',
  'converted_people_url',
] as const;
