import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { defineTaxonomy } from '@randomtoni/analytics-kit';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFlagClient } from './flags/create-flag-client';
import type { FeatureFlagDefinition } from './flags/local/neutral-definition';
import { createQueryClient } from './query/create-query-client';
import { buildMigrationSql } from './query/warehouse-schema';
import { createReceiverFromConfig } from './receiver/create-receiver-from-config';
import type { WireEvent } from './wire-mapper';

// E21-S3 — the E1 end-to-end zero-egress acceptance test (the self-host cycle CAPSTONE).
//
// Drives the FULL self-host loop against a REAL Postgres (>=16): migrate -> capture via the E19
// receiver -> query via the warehouse-selected client -> evaluate E20 static flags — asserting
// (1) ZERO HTTP egress (a recording transport whose log is EMPTY of any PostHog-shaped path) AND
// (2) results provably from the consumer's own Postgres (the funnel/retention counts equal what the
// receiver wrote). This two-sided proof is the behavioral-neutrality gate the fake-backed suites
// cannot give: count-faithfulness against a real SQL engine, not a mirror.
//
// The needs-Postgres tier: `describe.skipIf(!DATABASE_URL)` deselects the whole suite in the fast
// inner loop and runs it when opted into (a `DATABASE_URL`-set `turbo run test`). The turbo `test`
// task carries `env: ["DATABASE_URL"]` so the var is BOTH passed to the vitest child AND part of the
// cache key (an unset skipped-green run is not served stale to a set run).
//
// Isolation is a THROWAWAY DATABASE per run (not a search_path'd schema): the default driver opens a
// fresh connection per execute with no session hook, and the database name in the DSN path is the one
// routing piece every driver parses natively — no brittle libpq `options` passthrough whose silent
// fallback to `public` would contaminate the count assertions. The two language trees run against the
// same container in separate databases, zero shared namespace.

const DATABASE_URL = process.env.DATABASE_URL;

// The self-host taxonomy. Each count scenario uses its OWN event names so the counts are unambiguous:
// the funnel/retention/trend queries are GLOBAL over the `events` table, so sharing an event across
// scenarios would cross-contaminate the counts. Disjoint event names keep every count hand-computable.
// `plan` (string) and `tier` (number) are DECLARED event props, so the typed view projects a `plan`
// / `tier` column and a breakdown on either passes the E21-S5 SQL-gen declared-key guard. `tier` is
// the §4c half-(2) numeric proof — its `numeric::text` render is asserted end-to-end below.
const TAXONOMY = defineTaxonomy({
  events: {
    funnel_step_1: { plan: 'string', tier: 'number' },
    funnel_step_2: { plan: 'string', tier: 'number' },
    funnel_step_3: { plan: 'string', tier: 'number' },
    cohort_signup: { plan: 'string', tier: 'number' },
    return_order: {},
    page_loaded: { plan: 'string', tier: 'number' },
  },
  traits: { plan: 'string' },
});

// The neutral static flag definitions a self-host consumer authors — a 100%-rollout boolean flag and
// a disabled one, evaluated entirely in-process (no definition fetch, no /flags/ round-trip).
const STATIC_DEFINITIONS: FeatureFlagDefinition[] = [
  { key: 'new-checkout', enabled: true, conditions: [{ propertyFilters: [], rolloutPercentage: 100 }] },
  { key: 'legacy-banner', enabled: false, conditions: [] },
];

// A recording transport — ANY call is a self-host neutrality failure. Under the self-host config the
// warehouse rung wins ahead of the HTTP query ladder (so no HTTP query adapter is constructed) and
// the static/local-only flag adapter is fetch-INERT (constructed, but its seeded poller has no
// endpoint). We assert the log is EMPTY, and fail loudly if a PostHog-shaped path is ever contacted.
interface RecordedCall {
  url: string;
  method: string;
}

function createRecordingFetch(): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const recording = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    throw new Error(`egress attempted (${method} ${url}) — a self-host config must make no HTTP call`);
  }) as unknown as typeof fetch;
  return { fetch: recording, calls };
}

// The PostHog-shaped paths the recording log must be EMPTY of (per the epic zero-egress note).
const POSTHOG_SHAPED = [/\/api\/projects\/.*\/query\//, /\/flags\//, /\/batch\//];

// A minimal direct `pg` client, connected to a NAMED database, for the create/migrate/drop lifecycle
// and the raw count probes — the ONE place the test talks to Postgres outside the library seams
// (setup/teardown + provenance anchor, not the loop). `database` overrides the DSN's path segment.
// A runtime-only module specifier (mirrors `default-db-execute.ts`): the explicit `: string`
// widening keeps the compiler from resolving `pg`'s types at build time, so the optional peer being
// type-declaration-less (no `@types/pg`) breaks neither typecheck nor build — resolution is runtime.
const DRIVER_MODULE: string = 'pg';

interface DriverClient {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}
interface DriverModule {
  Client: new (config: { connectionString: string }) => DriverClient;
}

// Connect via the EXACT DSN string — no `database` override (whose precedence against a
// `connectionString` is driver-dependent) — so the migration/probe connection lands in exactly the
// database the receiver-write + query-read connections resolve `events`/`events_typed` in.
async function withClient<T>(
  dsn: string,
  fn: (query: (sql: string) => Promise<{ rows: unknown[] }>) => Promise<T>
): Promise<T> {
  const pg = (await import(DRIVER_MODULE)) as unknown as DriverModule;
  const client = new pg.Client({ connectionString: dsn });
  await client.connect();
  try {
    return await fn((sql) => client.query(sql));
  } finally {
    await client.end();
  }
}

// The DSN pointed at the throwaway database — its path segment is the per-run db, so every per-call
// connection the default driver opens (receiver-write + query-read) resolves `events`/`events_typed`
// there. Built by swapping the DSN's pathname.
function dsnForDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

// Build a capture batch body exactly as the node transport POSTs it: `{ api_key, batch, sent_at }`,
// gzipped with `Content-Encoding: gzip` (the receiver conditionally decompresses). This is the exact
// envelope the receiver reads back off the wire — the write S1's autocommit fix makes persist.
function batchBody(batch: WireEvent[]): { body: Buffer; headers: Record<string, string> } {
  const envelope = { api_key: 'self-host', batch, sent_at: '2026-01-05T10:00:00.000Z' };
  const json = Buffer.from(JSON.stringify(envelope), 'utf8');
  return { body: gzipSync(json), headers: { 'content-encoding': 'gzip' } };
}

function ev(
  event: string,
  distinct_id: string,
  timestamp: string,
  properties?: Record<string, unknown>
): WireEvent {
  return { uuid: randomUUID(), event, distinct_id, timestamp, properties };
}

// now()-relative helpers for the trend/unique_count smoke (their window is anchored on now(), unlike
// funnel/retention which window off the seeded timestamps and are wall-clock-independent).
function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe.skipIf(!DATABASE_URL)('E1 — end-to-end zero-egress acceptance (real Postgres)', () => {
  const database = `e21s3_${randomUUID().replace(/-/g, '')}`;
  let scopedDsn: string;

  beforeAll(async () => {
    scopedDsn = dsnForDatabase(DATABASE_URL as string, database);
    // CREATE DATABASE cannot run in a transaction and needs a connection to an existing db — connect
    // to the base DSN's own database for the create, then run the shipped migration (E17) via the
    // SCOPED DSN so it lands in exactly the throwaway database the seams will read/write.
    await withClient(DATABASE_URL as string, async (query) => {
      await query(`CREATE DATABASE ${database}`);
    });
    await withClient(scopedDsn, async (query) => {
      // buildMigrationSql emits `CREATE TABLE IF NOT EXISTS events` + `CREATE OR REPLACE VIEW
      // events_typed` — the multi-statement string runs verbatim into the throwaway database.
      await query(buildMigrationSql(TAXONOMY));
    });
  });

  afterAll(async () => {
    // Every DbExecute connection is per-call and already closed; DROP ... WITH (FORCE) evicts any
    // lingering connection so the drop cannot fail on a stray session.
    await withClient(DATABASE_URL as string, async (query) => {
      await query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    });
  });

  // Count what the receiver actually persisted, straight from the base table — the provenance anchor.
  async function eventCount(): Promise<number> {
    return withClient(scopedDsn, async (query) => {
      const result = (await query(`SELECT count(*)::int AS n FROM events`)) as { rows: Array<{ n: number }> };
      return result.rows[0].n;
    });
  }

  test('the full loop runs migrate -> capture -> query -> flags with no HTTP egress and counts provably from Postgres', async () => {
    const queryRec = createRecordingFetch();
    const flagRec = createRecordingFetch();

    // --- Step 2: POST a capture batch through the E19 receiver -> the `events` table ------------
    const receiver = createReceiverFromConfig({ warehouseDsn: scopedDsn });

    // Funnel (steps funnel_step_1 -> _2 -> _3, within 1 day; all step-0 at 10:00 so t0 is shared).
    // Each step takes min(timestamp) STRICTLY after the PRIOR step's matched `reached_at` and
    // <= t0 + within (inclusive upper bound). Disjoint event names from every other scenario so the
    // GLOBAL funnel query counts only these actors — no cross-contamination.
    //  A  full completion in order and in window                    -> reaches step 2
    //  B  step_3@11:00 precedes its step_2@12:00 reach              -> reaches step 1 only
    //     (step 2 needs a step_3 STRICTLY after reached_at=12:00; 11:00 < 12:00 -> no match)
    //  C  step_2 at t0+1day+1s, past the inclusive <= bound        -> reaches step 0 only
    //  D  partial (step_2, never step_3)                            -> reaches step 1
    // step-0 (funnel_step_1) carries the breakdown props: `plan` anchors the funnel breakdown group
    // (pro={A,C}, free={B,D}); `tier` is the numeric prop the trend breakdown proves renders as text.
    const funnelEvents: WireEvent[] = [
      ev('funnel_step_1', 'A', '2026-01-05T10:00:00Z', { plan: 'pro', tier: 42 }),
      ev('funnel_step_2', 'A', '2026-01-05T11:00:00Z', { plan: 'pro' }),
      ev('funnel_step_3', 'A', '2026-01-05T12:00:00Z'),
      ev('funnel_step_1', 'B', '2026-01-05T10:00:00Z', { plan: 'free', tier: 7 }),
      ev('funnel_step_3', 'B', '2026-01-05T11:00:00Z'),
      ev('funnel_step_2', 'B', '2026-01-05T12:00:00Z', { plan: 'free' }),
      ev('funnel_step_1', 'C', '2026-01-05T10:00:00Z', { plan: 'pro', tier: 42 }),
      ev('funnel_step_2', 'C', '2026-01-06T10:00:01Z', { plan: 'pro' }),
      ev('funnel_step_1', 'D', '2026-01-05T10:00:00Z', { plan: 'free', tier: 7 }),
      ev('funnel_step_2', 'D', '2026-01-05T10:30:00Z', { plan: 'free' }),
    ];

    // Retention (cohort cohort_signup -> return return_order, weekly, 3 periods). 2026-01-05 is a
    // Monday -> the ISO week bucket W0 = 2026-01-05. period_index 0 = the cohort's OWN week (returns
    // AT the cohort bucket, NOT the base cohort size). All cohort actors below sign up in W0.
    //   R1: returns W0 + W1 + W2                         -> p0,p1,p2 all retained
    //   R2: returns W1 ONLY (never its own week)         -> p0=0 (own-period edge), p1 retained
    //   R3: no return                                    -> contributes to no cell
    //   R4: returns W3 (past periods-1=2)                -> out-of-window: contributes to NOTHING
    // Distinct returners per W0 cell (this cohort, no breakdown): p0={R1}=1, p1={R1,R2}=2, p2={R1}=1.
    // cohort_signup carries `plan` — the retention breakdown group is anchored at the cohort event:
    // pro={R1,R3}, free={R2,R4}. In W0's own period only R1 (pro) returns, so p0[pro]=1, p0[free]=0.
    const W0 = '2026-01-05'; // Monday
    const retentionEvents: WireEvent[] = [
      ev('cohort_signup', 'R1', '2026-01-05T09:00:00Z', { plan: 'pro' }),
      ev('return_order', 'R1', '2026-01-05T12:00:00Z'), // W0 (own period)
      ev('return_order', 'R1', '2026-01-12T12:00:00Z'), // W1
      ev('return_order', 'R1', '2026-01-19T12:00:00Z'), // W2
      ev('cohort_signup', 'R2', '2026-01-05T09:00:00Z', { plan: 'free' }),
      ev('return_order', 'R2', '2026-01-12T12:00:00Z'), // W1 only — proves p0=0 for R2
      ev('cohort_signup', 'R3', '2026-01-05T09:00:00Z', { plan: 'pro' }), // never returns
      ev('cohort_signup', 'R4', '2026-01-05T09:00:00Z', { plan: 'free' }),
      ev('return_order', 'R4', '2026-01-26T12:00:00Z'), // W3, past periods-1 -> no grid cell
    ];

    // A returner who was NEVER in the cohort must be excluded (the cells CTE inner-joins cohort).
    const nonCohortReturner: WireEvent[] = [
      ev('return_order', 'X1', '2026-01-05T12:00:00Z'), // returns in W0 but no cohort_signup
    ];

    // E21-S5 RE-ADDS the BREAKDOWN scenario E21-S3 descoped (the Defect 3 fix): all three breakdown
    // builders now group on the typed view column `("<key>")::text` over `events_typed` (never raw
    // `properties`), so a breakdown trend/funnel/retention runs to completion on real Postgres. The
    // funnel/retention seeds above carry a DECLARED `plan` breakdown prop; the trend seeds carry a
    // DECLARED `tier` NUMBER prop for the numeric `::text` proof. Breakdown assertions are below.

    // now()-relative trend/unique_count smoke: page_loaded by two actors inside a 1-day window. The
    // `tier` NUMBER prop is the §4c half-(2) proof: a numeric breakdown key renders via Postgres
    // `numeric::text` to '42'/'7' (not '42.0') end-to-end. T1's two rows carry tier=42, T2's one row
    // tier=7 → breakdown-by-tier: total { '42': 2, '7': 1 }.
    const trendEvents: WireEvent[] = [
      ev('page_loaded', 'T1', isoMinutesAgo(30), { tier: 42 }),
      ev('page_loaded', 'T1', isoMinutesAgo(20), { tier: 42 }),
      ev('page_loaded', 'T2', isoMinutesAgo(10), { tier: 7 }),
    ];

    const allEvents = [
      ...funnelEvents,
      ...retentionEvents,
      ...nonCohortReturner,
      ...trendEvents,
    ];
    const { body, headers } = batchBody(allEvents);

    const outcome = await receiver.receive(body, headers);
    expect(outcome).toEqual({ outcome: 'accepted', accepted: allEvents.length });
    expect(await eventCount()).toBe(allEvents.length);

    // Idempotency: re-POSTing the SAME batch leaves the count unchanged (ON CONFLICT (uuid) DO NOTHING).
    const repeat = await receiver.receive(body, headers);
    expect(repeat).toEqual({ outcome: 'accepted', accepted: allEvents.length });
    expect(await eventCount()).toBe(allEvents.length);

    // --- Step 3: query via the warehouse-selected client (the warehouse rung, DSN present) -------
    // A recording `fetch` is supplied but must NEVER be called — the warehouse rung wins ahead of the
    // HTTP ladder, so no HTTP query adapter is constructed and no wire path is contacted.
    const query = createQueryClient({ warehouseDsn: scopedDsn, taxonomy: TAXONOMY, fetch: queryRec.fetch });

    // Funnel count-faithfulness (window-from-step-0 + boundary + out-of-order + partial).
    const funnel = await query.funnel({
      steps: ['funnel_step_1', 'funnel_step_2', 'funnel_step_3'],
      within: { value: 1, unit: 'day' },
    });
    const byStep = new Map(funnel.rows.map((r) => [r.step, r]));
    expect(byStep.get(0)?.count).toBe(4); // A,B,C,D signed up
    expect(byStep.get(1)?.count).toBe(3); // A,B,D reached step 1; C fell out at the inclusive boundary
    expect(byStep.get(2)?.count).toBe(1); // only A completed strictly after its order_placed reach
    expect(byStep.get(0)?.event).toBe('funnel_step_1');
    expect(byStep.get(2)?.event).toBe('funnel_step_3');
    expect(byStep.get(2)?.conversionRate).toBeCloseTo(1 / 4, 10); // 0.25

    // Retention count-faithfulness (period_index 0 = the cohort's own period; dense grid; bounded).
    const retention = await query.retention({
      cohortEvent: 'cohort_signup',
      returnEvent: 'return_order',
      periods: 3,
      granularity: 'week',
    });
    const w0Cells = retention.rows.filter((r) => r.cohort === W0);
    const cellByPeriod = new Map(w0Cells.map((r) => [r.periodIndex, r.value]));
    // p0 = {R1} = 1 (R2 returns only in W1 -> excluded from own-period; the own-period edge).
    expect(cellByPeriod.get(0)).toBe(1);
    expect(cellByPeriod.get(1)).toBe(2); // {R1,R2}
    expect(cellByPeriod.get(2)).toBe(1); // {R1}; R4's W3 return is out-of-window and lands on no cell.
    // Dense grid: exactly the periods {0,1,2} present (coalesce 0 fills empties), never a gap or a
    // phantom period 3 from R4's out-of-window return.
    expect(new Set(w0Cells.map((r) => r.periodIndex))).toEqual(new Set([0, 1, 2]));
    expect(w0Cells).toHaveLength(3);

    // (The breakdown trend/funnel/retention scenarios — E21-S5's Defect 3 fix — are asserted in
    // Step 3b below, grouping on the typed view column over real Postgres.)

    // Trend + unique_count smoke (now()-relative window). page_loaded: 3 total rows, 2 unique actors.
    // Assert the SUMMED value over the dense spine, never a pinned bucket label (wall-clock robust).
    const trend = await query.trend({ event: 'page_loaded', aggregation: 'total', window: { value: 1, unit: 'day' } });
    expect(trend.rows.reduce((sum, r) => sum + r.value, 0)).toBe(3);
    const unique = await query.uniqueCount({ event: 'page_loaded', window: { value: 1, unit: 'day' } });
    expect(unique.rows.reduce((sum, r) => sum + r.value, 0)).toBe(2);

    // raw_query over the consumer's own schema — a neutral column-keyed result from real Postgres.
    // cohort_signup rows: R1,R2,R3,R4 = 4 cohort_signup events.
    const raw = await query.rawQuery(`SELECT count(*)::int AS n FROM events WHERE event = 'cohort_signup'`);
    expect((raw.rows[0] as { n: number }).n).toBe(4);

    // --- Step 3b: the E21-S5 BREAKDOWN scenarios (Defect 3 fix, RE-ADDED) on real Postgres --------
    // Each groups on the typed view column `("<key>")::text` — no `column "properties" does not exist`.

    // Funnel breakdown by `plan` (anchored at funnel_step_1): pro={A,C}, free={B,D}. Only A (pro)
    // reaches step 2; B,D (free) reach step 1; C (pro) falls out at step 1's boundary. Per group:
    //   pro:  step0={A,C}=2, step1={A}=1, step2={A}=1
    //   free: step0={B,D}=2, step1={B,D}=2  (no actor reaches step 2 → the walk emits no free/step-2
    //                                        breakdown row; the group's rows stop at the reached step)
    const funnelBd = await query.funnel({
      steps: ['funnel_step_1', 'funnel_step_2', 'funnel_step_3'],
      within: { value: 1, unit: 'day' },
      breakdown: 'plan',
    });
    const byGroupStep = new Map(funnelBd.rows.map((r) => [`${r.breakdown}:${r.step}`, r.count]));
    expect(byGroupStep.get('pro:0')).toBe(2);
    expect(byGroupStep.get('pro:1')).toBe(1);
    expect(byGroupStep.get('pro:2')).toBe(1);
    expect(byGroupStep.get('free:0')).toBe(2);
    expect(byGroupStep.get('free:1')).toBe(2);
    // The free group never reaches step 2 — no free/step-2 row is emitted (the walk drives the groups).
    expect(byGroupStep.has('free:2')).toBe(false);
    // Both declared breakdown groups are present, each rendered as a Postgres text string.
    const funnelGroups = new Set(funnelBd.rows.map((r) => r.breakdown));
    expect(funnelGroups.has('pro')).toBe(true);
    expect(funnelGroups.has('free')).toBe(true);

    // Retention breakdown by `plan` (anchored at cohort_signup): pro={R1,R3}, free={R2,R4}. In W0's
    // own period only R1 (pro) returns → p0[pro]=1, p0[free]=0.
    const retentionBd = await query.retention({
      cohortEvent: 'cohort_signup',
      returnEvent: 'return_order',
      periods: 3,
      granularity: 'week',
      breakdown: 'plan',
    });
    const w0Bd = new Map(
      retentionBd.rows
        .filter((r) => r.cohort === W0)
        .map((r) => [`${r.breakdown}:${r.periodIndex}`, r.value])
    );
    expect(w0Bd.get('pro:0')).toBe(1); // {R1}
    expect(w0Bd.get('free:0')).toBe(0); // R2 returns only in W1 → own-period edge
    expect(new Set(retentionBd.rows.map((r) => r.breakdown))).toEqual(new Set(['pro', 'free']));

    // Trend breakdown by the `tier` NUMBER prop — the §4c half-(2) proof. Postgres renders
    // `numeric::text` as '42'/'7' (never '42.0') end-to-end. page_loaded totals per group:
    // tier=42 → 2 rows (T1×2), tier=7 → 1 row (T2×1).
    const trendBd = await query.trend({
      event: 'page_loaded',
      aggregation: 'total',
      window: { value: 1, unit: 'day' },
      breakdown: 'tier',
    });
    const totalByTier = new Map<string | undefined, number>();
    for (const r of trendBd.rows) {
      totalByTier.set(r.breakdown, (totalByTier.get(r.breakdown) ?? 0) + r.value);
    }
    expect(totalByTier.get('42')).toBe(2);
    expect(totalByTier.get('7')).toBe(1);
    // HALF (2): the numeric key rendered to the EXACT string '42' — not '42.0', not a Number repr.
    expect(totalByTier.has('42')).toBe(true);
    expect(totalByTier.has('42.0')).toBe(false);
    for (const r of trendBd.rows) {
      expect(typeof r.breakdown).toBe('string');
    }

    // --- Step 4: evaluate E20 static flags local-only (no definition/flag fetch) ------------------
    const flags = createFlagClient({
      key: 'self-host',
      staticDefinitions: STATIC_DEFINITIONS,
      onlyEvaluateLocally: true,
      fetch: flagRec.fetch,
    });
    try {
      const set = await flags.evaluate({ distinctId: 'A' });
      expect(set.getFlag('new-checkout')).toBe(true);
      expect(set.getFlag('legacy-banner')).toBe(false);
      expect(set.degraded).toBe(false);
    } finally {
      flags.stop();
    }

    // --- Step 5: the two-sided proof ------------------------------------------------------------
    // (1) Selection proof (strong form): the query fetch was never constructed-into-use and the
    //     static/local-only flag adapter is fetch-inert — both recording logs are EMPTY.
    expect(queryRec.calls).toEqual([]);
    expect(flagRec.calls).toEqual([]);
    for (const call of [...queryRec.calls, ...flagRec.calls]) {
      for (const shape of POSTHOG_SHAPED) {
        expect(call.url).not.toMatch(shape);
      }
    }
    // (2) Provenance proof: the queried counts equal what the receiver wrote — the data round-tripped
    //     through the consumer's own Postgres (asserted throughout via the funnel/retention counts).
    expect(await eventCount()).toBe(allEvents.length);
  });
});
