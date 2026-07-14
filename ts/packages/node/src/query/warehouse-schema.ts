import type { PropDecl, PropType, Taxonomy, TaxonomyDecl } from '@randomtoni/analytics-kit';

// The library-owned warehouse substrate: the `events` table DDL and the taxonomy-driven
// typed-VIEW generator, emitted as SQL STRINGS ONLY. This module imports no database driver
// and executes nothing — a caller obtains these strings and runs them against their own
// Postgres. It realizes the frozen write-side contract in
// `planning/WAREHOUSE-SCHEMA-CONTRACT.md`; the column set, the safe-cast view rule, the
// projection source (event-property decls only), the trait/group nesting guard, and the
// deterministic column order are all fixed there, not re-decided here.

// The single library-owned events table. Idempotent (`IF NOT EXISTS`) so a consumer can run
// the migration repeatedly. The columns ARE the neutral node batch envelope `WireEvent`
// (`uuid`, `event`, `distinct_id`, `properties`, `timestamp`) — one column per wire field, so
// the receiver is a thin persist. `uuid` is text (the neutral `dedupeId` is an opaque string,
// not required to be an RFC-4122 UUID) with a UNIQUE constraint — the idempotency key an
// `ON CONFLICT (uuid) DO NOTHING` receiver-write dedupes on. `timestamp` is NOT NULL by
// contract (the receiver supplies a default when the wire omits it). `properties` defaults to
// an empty object so a row with no props is still valid jsonb.
export const EVENTS_TABLE = 'events';

export const EVENTS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
  distinct_id text NOT NULL,
  event text NOT NULL,
  timestamp timestamptz NOT NULL,
  uuid text NOT NULL UNIQUE,
  properties jsonb NOT NULL DEFAULT '{}'
);`;

// The generated typed view's name — a taxonomy-independent constant. Query SQL (E18) targets
// this view, never `properties` directly.
export const EVENTS_VIEW = 'events_typed';

// The base columns, in the frozen fixed order. They lead every generated view, passed through
// from `events` unchanged, before any event-property projection.
const BASE_COLUMNS = ['distinct_id', 'event', 'timestamp', 'uuid'] as const;

// The trait/group [WIRE] keys that nest INSIDE `properties` (see `wire-mapper.ts`). The guard:
// no view column is ever named after one of these. They are projection-source-excluded by
// construction (the generator reads only `decl.events`, never `traits`/`groups`), so this set
// exists as an explicit belt-and-braces assertion the parity tests pin, not as a filter the
// generator needs to apply. Module-internal (`_`-prefixed): the parity test imports it from this
// module directly; it is deliberately NOT re-exported from the package `index.ts` — not consumer
// surface.
export const _TRAIT_GROUP_NESTED_KEYS = [
  'set',
  'set_once',
  'group_type',
  'group_key',
  'group_set',
] as const;

// The Postgres type each declared `PropType` casts to in the typed view.
const CAST_TYPE: Record<PropType, string> = {
  string: 'text',
  number: 'numeric',
  boolean: 'boolean',
  date: 'timestamptz',
};

// Double-quote a SQL identifier (the view column alias). Consumer prop keys are arbitrary
// strings, so quoting guards mixed case, reserved words, and punctuation; an embedded quote is
// doubled per the SQL standard.
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// Single-quote a SQL string literal (the JSONB key path). An embedded quote is doubled.
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// One safe-cast projection over `properties` for a declared event property. `->>` extracts the
// key as text (yielding NULL when the key is absent), and the cast is GUARDED by
// `pg_input_is_valid` so a present-but-uncastable value (e.g. `'abc'` under `::numeric`) yields
// NULL instead of raising — the greenfield/loose-JSONB posture the contract fixes. `text`
// needs no guard: `->>` is already text-or-NULL. One consistent guard shape across the typed
// casts keeps the emitted SQL uniform and byte-reproducible across both language trees.
function projectColumn(key: string, propType: PropType): string {
  const path = `properties ->> ${quoteLiteral(key)}`;
  const alias = quoteIdent(key);
  const castType = CAST_TYPE[propType];
  if (castType === 'text') {
    return `(${path})::text AS ${alias}`;
  }
  return `CASE WHEN pg_input_is_valid(${path}, ${quoteLiteral(castType)}) THEN (${path})::${castType} END AS ${alias}`;
}

// The union of declared event-property keys, each mapped to its declared `PropType`, in the
// frozen deterministic order: STABLE-SORTED BY PROP KEY ascending (byte-wise on the key
// string). A key that appears on multiple events resolves to the FIRST-declared event's type
// for that key (stable over the events' declaration order); the sort is by key only, so both
// language trees emit the identical column order regardless of how each walks its taxonomy.
function collectProjectionKeys(events: Record<string, PropDecl>): Array<[string, PropType]> {
  const byKey = new Map<string, PropType>();
  for (const propDecl of Object.values(events)) {
    for (const [key, propType] of Object.entries(propDecl)) {
      if (!byKey.has(key)) {
        byKey.set(key, propType);
      }
    }
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// Generate the `CREATE OR REPLACE VIEW` SQL for a taxonomy: base columns first (fixed order),
// then one safe-cast projection per declared event property (sorted by key). Reads
// `decl.events` ONLY — never `traits`/`groups`/`page`/`flags` — so the two trees' generators
// stay identical despite the taxonomy-shape asymmetries (the TS-only `page` slot etc.). Bakes
// in no consumer name: every column name comes from the taxonomy at call time. Idempotent
// (`CREATE OR REPLACE`).
export function buildTypedViewSql(taxonomy: Taxonomy<TaxonomyDecl>): string {
  const projections = collectProjectionKeys(taxonomy.decl.events).map(([key, propType]) =>
    projectColumn(key, propType)
  );
  const columns = [...BASE_COLUMNS, ...projections];
  const selectList = columns.map((c) => `  ${c}`).join(',\n');
  return `CREATE OR REPLACE VIEW ${EVENTS_VIEW} AS\nSELECT\n${selectList}\nFROM ${EVENTS_TABLE};`;
}

// The full shipped migration for a taxonomy: the fixed `events` table DDL followed by the
// generated typed view. This is the single idempotent artifact a consumer obtains and runs
// against their Postgres (re-running is safe: `CREATE TABLE IF NOT EXISTS` + `CREATE OR REPLACE
// VIEW`). It executes nothing here — it is a SQL string. Table-DDL and view-generator remain
// separately exported primitives; this is the thin ergonomic combiner over both.
export function buildMigrationSql(taxonomy: Taxonomy<TaxonomyDecl>): string {
  return `${EVENTS_TABLE_DDL}\n\n${buildTypedViewSql(taxonomy)}\n`;
}
