import { defineTaxonomy } from '@randomtoni/analytics-kit';
import { describe, expect, test } from 'vitest';
import {
  EVENTS_TABLE,
  EVENTS_TABLE_DDL,
  EVENTS_VIEW,
  _TRAIT_GROUP_NESTED_KEYS,
  buildMigrationSql,
  buildTypedViewSql,
} from './warehouse-schema';

// A representative taxonomy exercising every branch the generator must handle:
// - all four PropTypes (string/number/boolean/date);
// - a prop key (`plan`) declared on TWO events (union-dedup);
// - mixed-case keys (`Referrer`, `zeta`) that must sort byte-wise (uppercase < lowercase),
//   proving code-point order, not locale collation;
// - a `traits` slot and a `groups` slot whose keys must NOT surface as view columns;
// - a bare `{}` event with no props.
const representative = defineTaxonomy({
  events: {
    signed_up: { plan: 'string', seats: 'number', Referrer: 'string' },
    order_placed: { amount: 'number', is_gift: 'boolean', plan: 'string', placed_at: 'date' },
    page_loaded: {},
    zeta_event: { zeta: 'string' },
  },
  traits: { set: 'string', loyalty_tier: 'string' },
  groups: { company: { group_key: 'string', seat_count: 'number' } },
});

// The exact byte string the generator MUST emit for `representative`. The Python parity test
// pins this identical string — the two trees produce byte-for-byte the same SQL. Column order:
// base columns (fixed) then event-prop projections sorted by key byte-wise ascending —
// Referrer (uppercase R = 0x52) sorts before all lowercase, then amount, is_gift, placed_at,
// plan, seats, zeta.
const EXPECTED_VIEW_SQL = `CREATE OR REPLACE VIEW events_typed AS
SELECT
  distinct_id,
  event,
  timestamp,
  uuid,
  (properties ->> 'Referrer')::text AS "Referrer",
  CASE WHEN pg_input_is_valid(properties ->> 'amount', 'numeric') THEN (properties ->> 'amount')::numeric END AS "amount",
  CASE WHEN pg_input_is_valid(properties ->> 'is_gift', 'boolean') THEN (properties ->> 'is_gift')::boolean END AS "is_gift",
  CASE WHEN pg_input_is_valid(properties ->> 'placed_at', 'timestamptz') THEN (properties ->> 'placed_at')::timestamptz END AS "placed_at",
  (properties ->> 'plan')::text AS "plan",
  CASE WHEN pg_input_is_valid(properties ->> 'seats', 'numeric') THEN (properties ->> 'seats')::numeric END AS "seats",
  (properties ->> 'zeta')::text AS "zeta"
FROM events;`;

describe('events table DDL', () => {
  test('is an idempotent CREATE TABLE with exactly the S1-frozen columns', () => {
    expect(EVENTS_TABLE).toBe('events');
    expect(EVENTS_TABLE_DDL).toBe(`CREATE TABLE IF NOT EXISTS events (
  distinct_id text NOT NULL,
  event text NOT NULL,
  timestamp timestamptz NOT NULL,
  uuid text NOT NULL UNIQUE,
  properties jsonb NOT NULL DEFAULT '{}'
);`);
  });

  test('is idempotent (IF NOT EXISTS) and carries no domain column', () => {
    expect(EVENTS_TABLE_DDL).toContain('CREATE TABLE IF NOT EXISTS');
    // The five frozen columns and nothing else — no domain/tenant/consumer column.
    for (const col of ['distinct_id', 'event', 'timestamp', 'uuid', 'properties']) {
      expect(EVENTS_TABLE_DDL).toContain(col);
    }
    expect(EVENTS_TABLE_DDL).not.toMatch(/domain|tenant|consumer|project_id/);
  });

  test('uuid carries the UNIQUE constraint (the idempotency key)', () => {
    expect(EVENTS_TABLE_DDL).toMatch(/uuid text NOT NULL UNIQUE/);
  });

  test('timestamp is NOT NULL by contract', () => {
    expect(EVENTS_TABLE_DDL).toMatch(/timestamp timestamptz NOT NULL/);
  });
});

describe('typed view generator', () => {
  test('emits the exact expected view SQL for the representative taxonomy (byte-pinned)', () => {
    expect(buildTypedViewSql(representative)).toBe(EXPECTED_VIEW_SQL);
  });

  test('is idempotent (CREATE OR REPLACE VIEW)', () => {
    expect(buildTypedViewSql(representative)).toContain(`CREATE OR REPLACE VIEW ${EVENTS_VIEW}`);
  });

  test('base columns lead in the fixed order, unchanged (no cast)', () => {
    const sql = buildTypedViewSql(representative);
    const selectBody = sql.slice(sql.indexOf('SELECT'));
    const distinctIdx = selectBody.indexOf('distinct_id');
    const eventIdx = selectBody.indexOf('\n  event,');
    const timestampIdx = selectBody.indexOf('\n  timestamp,');
    const uuidIdx = selectBody.indexOf('\n  uuid,');
    expect(distinctIdx).toBeGreaterThan(-1);
    expect(distinctIdx).toBeLessThan(eventIdx);
    expect(eventIdx).toBeLessThan(timestampIdx);
    expect(timestampIdx).toBeLessThan(uuidIdx);
  });

  test('projects one safe-cast column per PropType, never raw JSONB', () => {
    const sql = buildTypedViewSql(representative);
    // string → ::text (unguarded, ->> already text-or-NULL)
    expect(sql).toContain(`(properties ->> 'plan')::text AS "plan"`);
    // number → guarded ::numeric
    expect(sql).toContain(
      `CASE WHEN pg_input_is_valid(properties ->> 'amount', 'numeric') THEN (properties ->> 'amount')::numeric END AS "amount"`
    );
    // boolean → guarded ::boolean
    expect(sql).toContain(
      `CASE WHEN pg_input_is_valid(properties ->> 'is_gift', 'boolean') THEN (properties ->> 'is_gift')::boolean END AS "is_gift"`
    );
    // date → guarded ::timestamptz
    expect(sql).toContain(
      `CASE WHEN pg_input_is_valid(properties ->> 'placed_at', 'timestamptz') THEN (properties ->> 'placed_at')::timestamptz END AS "placed_at"`
    );
    // never a bare raw-JSONB projection of `properties` itself
    expect(sql).not.toMatch(/AS "properties"/);
  });

  test('dedups a prop key declared on multiple events into one column', () => {
    const sql = buildTypedViewSql(representative);
    const occurrences = sql.match(/AS "plan"/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  test('orders event-prop columns by prop key byte-wise ascending (uppercase before lowercase, not locale)', () => {
    const sql = buildTypedViewSql(representative);
    const order = ['"Referrer"', '"amount"', '"is_gift"', '"placed_at"', '"plan"', '"seats"', '"zeta"'];
    const positions = order.map((col) => sql.indexOf(`AS ${col}`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // Uppercase-R sorts BEFORE lowercase-a — proves code-point order, not localeCompare.
    expect(sql.indexOf('AS "Referrer"')).toBeLessThan(sql.indexOf('AS "amount"'));
  });

  test('names no view column after a trait/group nested key (the S1 guard)', () => {
    const sql = buildTypedViewSql(representative);
    for (const key of _TRAIT_GROUP_NESTED_KEYS) {
      expect(sql).not.toContain(`AS "${key}"`);
    }
    // `set` was declared under `traits` and `group_key` under `groups`; neither surfaces.
    expect(sql).not.toContain(`AS "set"`);
    expect(sql).not.toContain(`AS "group_key"`);
    // trait/group keys that are NOT event-prop decls never become columns
    expect(sql).not.toContain(`AS "loyalty_tier"`);
    expect(sql).not.toContain(`AS "seat_count"`);
  });

  test('bakes in no consumer/event name — event NAMES never appear as columns', () => {
    const sql = buildTypedViewSql(representative);
    // event names are keys of `decl.events`; they must not leak as columns
    for (const eventName of ['signed_up', 'order_placed', 'page_loaded', 'zeta_event']) {
      expect(sql).not.toContain(`AS "${eventName}"`);
    }
  });

  test('an empty-events taxonomy yields only the base columns', () => {
    const empty = defineTaxonomy({ events: {} });
    expect(buildTypedViewSql(empty)).toBe(`CREATE OR REPLACE VIEW events_typed AS
SELECT
  distinct_id,
  event,
  timestamp,
  uuid
FROM events;`);
  });

  test('escapes quote characters in a prop key (identifier and literal escaping)', () => {
    const tricky = defineTaxonomy({ events: { e: { 'a"b': 'string', "c'd": 'number' } } });
    const sql = buildTypedViewSql(tricky);
    // double-quote in the identifier is doubled; sort byte-wise: `"` (0x22) < `'` (0x27)
    expect(sql).toContain(`(properties ->> 'a"b')::text AS "a""b"`);
    // single-quote in the JSONB literal is doubled
    expect(sql).toContain(`pg_input_is_valid(properties ->> 'c''d', 'numeric')`);
    expect(sql).toContain(`(properties ->> 'c''d')::numeric END AS "c'd"`);
  });
});

describe('migration SQL', () => {
  test('concatenates the table DDL then the typed view, idempotently', () => {
    const migration = buildMigrationSql(representative);
    expect(migration).toBe(`${EVENTS_TABLE_DDL}\n\n${EXPECTED_VIEW_SQL}\n`);
  });

  test('is safe to re-run: IF NOT EXISTS table + CREATE OR REPLACE view', () => {
    const migration = buildMigrationSql(representative);
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS events');
    expect(migration).toContain('CREATE OR REPLACE VIEW events_typed');
    // table DDL must precede the view (the view depends on the base table)
    expect(migration.indexOf('CREATE TABLE')).toBeLessThan(migration.indexOf('CREATE OR REPLACE VIEW'));
  });

  test('names no vendor and carries no $-prefixed column', () => {
    const migration = buildMigrationSql(representative);
    expect(migration.toLowerCase()).not.toContain('posthog');
    expect(migration).not.toMatch(/\$[a-z]/i);
  });
});
