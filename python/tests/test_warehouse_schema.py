"""The warehouse substrate — events DDL + typed-view generator + migration, at TS parity.

These tests pin the generated SQL BYTE-FOR-BYTE against the same fixed strings the TypeScript
``warehouse-schema.test.ts`` asserts. The two trees emit identical Postgres for the same
taxonomy — the deterministic column order (base columns fixed, then event-prop projections sorted
by key byte-wise) is what makes "equivalent" mean byte-for-byte, not merely set-equal. Any drift
in whitespace, casing, escaping, or column order between the trees fails here.
"""

from __future__ import annotations

from analytics_kit import (
    EVENTS_TABLE,
    EVENTS_TABLE_DDL,
    EVENTS_VIEW,
    build_migration_sql,
    build_typed_view_sql,
    define_taxonomy,
)
from analytics_kit.query.warehouse_schema import TRAIT_GROUP_NESTED_KEYS

# The SAME representative taxonomy the TS test uses: all four PropTypes; a key (`plan`) on two
# events; mixed-case keys (`Referrer`) proving byte-wise sort; trait/group slots whose keys must
# not surface; a bare `{}` event.
_representative = define_taxonomy(
    {
        "events": {
            "signed_up": {"plan": "string", "seats": "number", "Referrer": "string"},
            "order_placed": {
                "amount": "number",
                "is_gift": "boolean",
                "plan": "string",
                "placed_at": "date",
            },
            "page_loaded": {},
            "zeta_event": {"zeta": "string"},
        },
        "traits": {"set": "string", "loyalty_tier": "string"},
        "groups": {"company": {"group_key": "string", "seat_count": "number"}},
    }
)

# The EXACT byte string — identical to `EXPECTED_VIEW_SQL` in the TS test. This shared constant
# IS the cross-tree byte-parity assertion.
_EXPECTED_VIEW_SQL = """CREATE OR REPLACE VIEW events_typed AS
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
FROM events;"""

_EXPECTED_TABLE_DDL = """CREATE TABLE IF NOT EXISTS events (
  distinct_id text NOT NULL,
  event text NOT NULL,
  timestamp timestamptz NOT NULL,
  uuid text NOT NULL UNIQUE,
  properties jsonb NOT NULL DEFAULT '{}'
);"""


# --- events table DDL ---------------------------------------------------------------------


def test_events_table_ddl_is_the_frozen_idempotent_shape() -> None:
    assert EVENTS_TABLE == "events"
    assert EVENTS_TABLE_DDL == _EXPECTED_TABLE_DDL


def test_events_table_ddl_is_idempotent_and_has_no_domain_column() -> None:
    assert "CREATE TABLE IF NOT EXISTS" in EVENTS_TABLE_DDL
    for col in ("distinct_id", "event", "timestamp", "uuid", "properties"):
        assert col in EVENTS_TABLE_DDL
    for domain_col in ("domain", "tenant", "consumer", "project_id"):
        assert domain_col not in EVENTS_TABLE_DDL


def test_uuid_is_unique_and_timestamp_not_null() -> None:
    assert "uuid text NOT NULL UNIQUE" in EVENTS_TABLE_DDL
    assert "timestamp timestamptz NOT NULL" in EVENTS_TABLE_DDL


# --- typed view generator -----------------------------------------------------------------


def test_typed_view_sql_is_byte_identical_to_the_expected_parity_string() -> None:
    assert build_typed_view_sql(_representative) == _EXPECTED_VIEW_SQL


def test_typed_view_is_idempotent() -> None:
    assert f"CREATE OR REPLACE VIEW {EVENTS_VIEW}" in build_typed_view_sql(_representative)


def test_base_columns_lead_in_the_fixed_order_uncast() -> None:
    sql = build_typed_view_sql(_representative)
    select_body = sql[sql.index("SELECT") :]
    idx = [
        select_body.index("distinct_id"),
        select_body.index("\n  event,"),
        select_body.index("\n  timestamp,"),
        select_body.index("\n  uuid,"),
    ]
    assert idx == sorted(idx)


def test_projects_one_safe_cast_per_prop_type_never_raw_jsonb() -> None:
    sql = build_typed_view_sql(_representative)
    assert "(properties ->> 'plan')::text AS \"plan\"" in sql
    assert (
        "CASE WHEN pg_input_is_valid(properties ->> 'amount', 'numeric') "
        "THEN (properties ->> 'amount')::numeric END AS \"amount\"" in sql
    )
    assert (
        "CASE WHEN pg_input_is_valid(properties ->> 'is_gift', 'boolean') "
        "THEN (properties ->> 'is_gift')::boolean END AS \"is_gift\"" in sql
    )
    assert (
        "CASE WHEN pg_input_is_valid(properties ->> 'placed_at', 'timestamptz') "
        "THEN (properties ->> 'placed_at')::timestamptz END AS \"placed_at\"" in sql
    )
    assert 'AS "properties"' not in sql


def test_dedups_a_key_declared_on_multiple_events() -> None:
    sql = build_typed_view_sql(_representative)
    assert sql.count('AS "plan"') == 1


def test_columns_sorted_by_key_byte_wise_not_locale() -> None:
    sql = build_typed_view_sql(_representative)
    order = ['"Referrer"', '"amount"', '"is_gift"', '"placed_at"', '"plan"', '"seats"', '"zeta"']
    positions = [sql.index(f"AS {col}") for col in order]
    assert positions == sorted(positions)
    # Uppercase-R (0x52) sorts before lowercase-a (0x61) — code-point order, not locale.
    assert sql.index('AS "Referrer"') < sql.index('AS "amount"')


def test_names_no_view_column_after_a_trait_or_group_key() -> None:
    sql = build_typed_view_sql(_representative)
    for key in TRAIT_GROUP_NESTED_KEYS:
        assert f'AS "{key}"' not in sql
    # `set` (a trait) and `group_key` (a group prop) never surface as columns
    assert 'AS "set"' not in sql
    assert 'AS "group_key"' not in sql
    # non-event-prop trait/group keys never become columns
    assert 'AS "loyalty_tier"' not in sql
    assert 'AS "seat_count"' not in sql


def test_bakes_in_no_event_name_as_a_column() -> None:
    sql = build_typed_view_sql(_representative)
    for event_name in ("signed_up", "order_placed", "page_loaded", "zeta_event"):
        assert f'AS "{event_name}"' not in sql


def test_empty_events_taxonomy_yields_only_base_columns() -> None:
    empty = define_taxonomy({"events": {}})
    assert build_typed_view_sql(empty) == (
        "CREATE OR REPLACE VIEW events_typed AS\n"
        "SELECT\n"
        "  distinct_id,\n"
        "  event,\n"
        "  timestamp,\n"
        "  uuid\n"
        "FROM events;"
    )


def test_escapes_quote_characters_in_a_prop_key() -> None:
    tricky = define_taxonomy({"events": {"e": {'a"b': "string", "c'd": "number"}}})
    sql = build_typed_view_sql(tricky)
    # double-quote in identifier doubled; sort byte-wise: `"` (0x22) < `'` (0x27)
    assert '(properties ->> \'a"b\')::text AS "a""b"' in sql
    # single-quote in the JSONB literal doubled
    assert "pg_input_is_valid(properties ->> 'c''d', 'numeric')" in sql
    assert "(properties ->> 'c''d')::numeric END AS \"c'd\"" in sql


# --- migration SQL ------------------------------------------------------------------------


def test_migration_concatenates_table_ddl_then_view_idempotently() -> None:
    migration = build_migration_sql(_representative)
    assert migration == f"{EVENTS_TABLE_DDL}\n\n{_EXPECTED_VIEW_SQL}\n"


def test_migration_is_safe_to_rerun_and_ordered_table_first() -> None:
    migration = build_migration_sql(_representative)
    assert "CREATE TABLE IF NOT EXISTS events" in migration
    assert "CREATE OR REPLACE VIEW events_typed" in migration
    assert migration.index("CREATE TABLE") < migration.index("CREATE OR REPLACE VIEW")


def test_migration_names_no_vendor_and_no_dollar_column() -> None:
    migration = build_migration_sql(_representative).lower()
    assert "posthog" not in migration
    # no $-prefixed identifier
    assert "$" not in migration
