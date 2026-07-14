"""The default DB-execute implementation, backed by the standard Postgres driver.

Gated behind the ``analytics-kit[warehouse]`` optional-dependency extra. Named by ROLE (never by
driver): the exported surface says nothing about which client backs it, so a future non-Postgres
warehouse is one new driver behind the SAME :class:`~analytics_kit.query.db_execute.DbExecute` seam.

The driver is imported LAZILY: importing this module without the extra installed does not import
the driver and does not error — a clear neutral error is raised only when the default driver is
actually CONSTRUCTED. This mirrors the ``analytics-kit[django]``/``[fastapi]`` extra convention.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from typing import Protocol

from .db_execute import DbColumn, DbExecute, DbExecuteResult

try:
    import psycopg  # noqa: F401

    _WAREHOUSE_DRIVER_AVAILABLE = True
except ImportError:
    _WAREHOUSE_DRIVER_AVAILABLE = False


_DRIVER_MISSING = (
    "analytics-kit: the default warehouse driver requires the `analytics-kit[warehouse]` "
    "extra — install it or supply your own DbExecute."
)

# The builders emit driver-agnostic positional `$N` placeholders (Postgres-native, byte-identical to
# the TS tree). The DB-API driver behind this seam accepts only `%s` positional placeholders, so the
# driver — the ONE layer that knows which paramstyle it speaks — rewrites `$N` to `%s` here, exactly
# as it already adapts the cursor into the neutral DbExecuteResult. Full-token regex (never a substring
# replace: `$1` is a prefix of `$10`); positional order is preserved because the builders generate
# `$1..$N` in strict lockstep with the flat params. The emitted SQL the neutrality scan and the
# parity fixtures assert on is UNCHANGED — only what crosses into the driver is adapted. No injection
# surface: the `$N` tokens are builder-generated, never consumer input. For raw_query the rewrite is a
# no-op ONLY when the raw SQL carries no `$digit` token; a `$N`-shaped literal in raw SQL WOULD be
# rewritten to `%s` (raw_query passes no params, so such a rewritten placeholder then binds nothing).
# The builders emit no `%` literal today; if one is ever added it must be `%%`-escaped at the builder
# — out of this seam's scope.
_POSITIONAL_PLACEHOLDER = re.compile(r"\$\d+")


class _CursorLike(Protocol):
    """The minimal, private structural mirror of the driver's cursor — the ONLY driver-shaped
    contract in the module, owned here, never imported from the driver. ``description`` is the
    DB-API sequence of column descriptors (first field is the column name)."""

    description: Sequence[Sequence[object]] | None

    def fetchall(self) -> Iterable[Sequence[object]]: ...


def _result_from_cursor(cursor: _CursorLike) -> DbExecuteResult:
    """Map a DB-API cursor into the neutral :class:`DbExecuteResult` — positional-cell rows +
    ordered name columns. Pure over the structural cursor contract, so it is testable without a
    live driver (the driver-boundary edge stays in :meth:`DefaultDbExecute.execute`)."""
    # A non-RETURNING write (e.g. INSERT ... ON CONFLICT DO NOTHING) leaves description None and
    # produces no result set; calling fetchall() there raises on a real DB-API driver.
    if cursor.description is None:
        return DbExecuteResult(rows=[], columns=[])
    columns = [DbColumn(name=str(desc[0])) for desc in cursor.description]
    rows: list[Sequence[object]] = [tuple(row) for row in cursor.fetchall()]
    return DbExecuteResult(rows=rows, columns=columns)


class DefaultDbExecute:
    """A :class:`~analytics_kit.query.db_execute.DbExecute` backed by the Postgres driver.

    Opens a connection per :meth:`execute` from the configured DSN and maps the driver's cursor
    result into the neutral :class:`DbExecuteResult` — no driver handle crosses the seam. Raises a
    clear neutral :class:`RuntimeError` naming the ``analytics-kit[warehouse]`` extra if
    constructed without the driver installed.
    """

    def __init__(self, warehouse_dsn: str) -> None:
        if not _WAREHOUSE_DRIVER_AVAILABLE:
            raise RuntimeError(_DRIVER_MISSING)
        self._dsn = warehouse_dsn

    def execute(
        self, sql: str, params: Sequence[object] | None = None
    ) -> DbExecuteResult:
        # autocommit so each execute is one independent, committed statement: the driver holds no
        # cross-call transaction, and without it the connection close would roll back a write.
        conn = psycopg.connect(self._dsn, autocommit=True)
        try:
            with conn.cursor() as cursor:
                cursor.execute(_POSITIONAL_PLACEHOLDER.sub("%s", sql), params)
                return _result_from_cursor(cursor)
        finally:
            conn.close()


def create_default_db_execute(warehouse_dsn: str) -> DbExecute:
    """Construct the default DB-execute driver from a warehouse DSN.

    Returns a :class:`~analytics_kit.query.db_execute.DbExecute`. Raises a neutral
    :class:`RuntimeError` naming the ``analytics-kit[warehouse]`` extra if the driver is absent.
    """
    return DefaultDbExecute(warehouse_dsn)
