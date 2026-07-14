"""The library-owned warehouse substrate — ``events`` DDL + taxonomy-driven typed view.

Emits SQL as **strings only**: this module imports no database driver and executes nothing —
a caller obtains these strings and runs them against their own Postgres. It realizes the frozen
write-side contract in ``planning/WAREHOUSE-SCHEMA-CONTRACT.md``; the column set, the safe-cast
view rule, the projection source (event-property decls only), the trait/group nesting guard, and
the deterministic column order are all fixed there, not re-decided here.

Parity is by shared contract, not shared code: this generator emits **byte-identical** DDL and
view SQL to the TypeScript ``warehouse-schema.ts`` for the same taxonomy — the SQL is Postgres and
therefore language-agnostic; only the surrounding generator code is cased idiomatically.
"""

from __future__ import annotations

from ..taxonomy import PropDecl, PropType, Taxonomy

__all__ = [
    "EVENTS_TABLE",
    "EVENTS_TABLE_DDL",
    "EVENTS_VIEW",
    "build_typed_view_sql",
    "build_migration_sql",
    # Cross-module (node-package-internal) helpers the warehouse SQL builders share so the view
    # generator and the breakdown path quote identifiers + derive the declarable-key set through
    # ONE function. Exported for the SQL module's import only — NOT re-exported from the query
    # package surface (see query/__init__.py, which surfaces neither).
    "_quote_ident",
    "_collect_projection_keys",
]

EVENTS_TABLE = "events"
"""The single library-owned events table name."""

EVENTS_TABLE_DDL = f"""CREATE TABLE IF NOT EXISTS {EVENTS_TABLE} (
  distinct_id text NOT NULL,
  event text NOT NULL,
  timestamp timestamptz NOT NULL,
  uuid text NOT NULL UNIQUE,
  properties jsonb NOT NULL DEFAULT '{{}}'
);"""
"""Idempotent DDL for the events table.

The columns ARE the neutral node batch envelope (``uuid``, ``event``, ``distinct_id``,
``properties``, ``timestamp``) — one column per wire field. ``uuid`` is text (the neutral
``dedupe_id`` is an opaque string) with a UNIQUE constraint — the idempotency key an
``ON CONFLICT (uuid) DO NOTHING`` receiver-write dedupes on. ``timestamp`` is NOT NULL by
contract (the receiver supplies a default when the wire omits it). ``properties`` defaults to an
empty object so a propless row is still valid jsonb.
"""

EVENTS_VIEW = "events_typed"
"""The generated typed view's name — taxonomy-independent. Query SQL targets this, not
``properties`` directly."""

# The base columns, in the frozen fixed order. They lead every generated view, passed through
# from `events` unchanged, before any event-property projection.
_BASE_COLUMNS = ("distinct_id", "event", "timestamp", "uuid")

_TRAIT_GROUP_NESTED_KEYS = ("set", "set_once", "group_type", "group_key", "group_set")
"""The trait/group [WIRE] keys that nest INSIDE ``properties`` (see the node wire-mapper).

The guard: no view column is ever named after one of these. They are projection-source-excluded
by construction (the generator reads only ``decl['events']``), so this tuple is a belt-and-braces
assertion the parity tests pin, not a filter the generator applies. Module-internal
(``_``-prefixed): the parity test imports it from this module directly; it is deliberately absent
from ``__all__`` and never re-exported — not consumer surface.
"""

# The Postgres type each declared PropType casts to in the typed view.
_CAST_TYPE: dict[PropType, str] = {
    "string": "text",
    "number": "numeric",
    "boolean": "boolean",
    "date": "timestamptz",
}


def _quote_ident(name: str) -> str:
    """Double-quote a SQL identifier (the view column alias), doubling any embedded quote.

    Consumer prop keys are arbitrary strings, so quoting guards mixed case, reserved words, and
    punctuation.
    """
    escaped = name.replace('"', '""')
    return f'"{escaped}"'


def _quote_literal(value: str) -> str:
    """Single-quote a SQL string literal (the JSONB key path), doubling any embedded quote."""
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def _project_column(key: str, prop_type: PropType) -> str:
    """One safe-cast projection over ``properties`` for a declared event property.

    ``->>`` extracts the key as text (NULL when absent); the cast is GUARDED by
    ``pg_input_is_valid`` so a present-but-uncastable value yields NULL instead of raising — the
    greenfield/loose-JSONB posture. ``text`` needs no guard (``->>`` is already text-or-NULL).
    """
    path = f"properties ->> {_quote_literal(key)}"
    alias = _quote_ident(key)
    cast_type = _CAST_TYPE[prop_type]
    if cast_type == "text":
        return f"({path})::text AS {alias}"
    return (
        f"CASE WHEN pg_input_is_valid({path}, {_quote_literal(cast_type)}) "
        f"THEN ({path})::{cast_type} END AS {alias}"
    )


def _collect_projection_keys(events: dict[str, PropDecl]) -> list[tuple[str, PropType]]:
    """Union of declared event-property keys, each mapped to its PropType, in frozen order.

    Deterministic order: STABLE-SORTED BY PROP KEY ascending (byte-wise / code-point on the key
    string — plain ``sorted``, never locale collation). A key on multiple events resolves to the
    first-declared event's type for that key. Both language trees emit the identical column order.
    """
    by_key: dict[str, PropType] = {}
    for prop_decl in events.values():
        for key, prop_type in prop_decl.items():
            if key not in by_key:
                by_key[key] = prop_type
    return sorted(by_key.items(), key=lambda item: item[0])


def build_typed_view_sql(taxonomy: Taxonomy) -> str:
    """Generate the ``CREATE OR REPLACE VIEW`` SQL for a taxonomy.

    Base columns first (fixed order), then one safe-cast projection per declared event property
    (sorted by key). Reads ``decl['events']`` ONLY — never ``traits``/``groups``/``flags`` — so
    the two trees' generators stay identical despite taxonomy-shape asymmetries. Bakes in no
    consumer name: every column name comes from the taxonomy at call time. Idempotent
    (``CREATE OR REPLACE``).
    """
    events: dict[str, PropDecl] = taxonomy.decl["events"]
    projections = [_project_column(key, prop_type) for key, prop_type in _collect_projection_keys(events)]
    columns = [*_BASE_COLUMNS, *projections]
    select_list = ",\n".join(f"  {c}" for c in columns)
    return f"CREATE OR REPLACE VIEW {EVENTS_VIEW} AS\nSELECT\n{select_list}\nFROM {EVENTS_TABLE};"


def build_migration_sql(taxonomy: Taxonomy) -> str:
    """The full shipped migration: the fixed ``events`` table DDL then the generated typed view.

    A single idempotent artifact the consumer obtains and runs against their Postgres (re-running
    is safe: ``CREATE TABLE IF NOT EXISTS`` + ``CREATE OR REPLACE VIEW``). Executes nothing —
    it is a SQL string. Table-DDL and view-generator remain separate primitives; this is the thin
    combiner over both, table DDL first (the view depends on the base table).
    """
    return f"{EVENTS_TABLE_DDL}\n\n{build_typed_view_sql(taxonomy)}\n"
