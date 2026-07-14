"""The DB-execute seam — the SQL analog of the HTTP ``QueryTransport`` injection.

The warehouse adapter (E18) and any DDL execution route SQL through this injectable seam, so no
driver handle ever crosses it — exactly like ``QueryTransport`` returning the neutral
:class:`~analytics_kit.NeutralResponse` the adapter reads rather than a live driver connection.
Named by ROLE, never by driver: nothing here references a specific Postgres client. A fake
satisfies the :class:`DbExecute` Protocol for unit tests without a real database.

The result is its OWN backend-agnostic shape — DISTINCT from :class:`~analytics_kit.QueryResult`
(which stamps ``generated_at``/``from_cache`` + per-primitive typed rows a raw exec cannot own)
and from :class:`~analytics_kit.NeutralResponse` (the HTTP-shaped ``status``/``body`` envelope).
It is the raw-payload tier BELOW ``QueryResult``: E18's adapter bodies normalize a
:class:`DbExecuteResult` INTO a ``QueryResult`` themselves, exactly as the HTTP adapter normalizes
its wire envelope. ``rows`` are sequences-of-sequences (positional cells) — the native driver
shape the existing ``_zip_row`` helper already expects — keyed positionally by ``columns`` order.

``execute`` is SYNC — matching the deliberately-sync Python query posture (``AnalyticsQueryClient``
is sync; the HTTP poll is a blocking ``time.sleep``, never asyncio). This mirrors the existing
HTTP-adapter sync/async split (TS is async); it is intentional, not a parity miss.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


@dataclass(frozen=True)
class DbColumn:
    """One result column — a name and an optional driver-reported type.

    Mirrors the neutral :class:`~analytics_kit.QueryColumn` (``name``/``type``), kept DISTINCT and
    ordered so an empty result still carries its schema. ``type`` is optional: the driver reports
    it, but a raw exec need not depend on it.
    """

    name: str
    type: str | None = None


@dataclass(frozen=True)
class DbExecuteResult:
    """The neutral raw-exec payload — positional-cell ``rows`` + ordered ``columns``.

    Its own backend-agnostic shape, DISTINCT from ``QueryResult`` and ``NeutralResponse`` (see the
    module docstring). ``rows`` are sequences-of-sequences (positional cells), keyed positionally
    by ``columns`` order — the native driver shape the existing ``_zip_row`` helper expects.
    """

    rows: Sequence[Sequence[object]] = field(default_factory=list)
    columns: list[DbColumn] = field(default_factory=list)


@runtime_checkable
class DbExecute(Protocol):
    """The injectable DB-execute hook — SQL + positional params in, neutral result out.

    Mirrors the :class:`~analytics_kit.query.client.QueryTransport` posture: a single ``execute``
    method returning a neutral rows/columns object, never a driver handle. Sync by posture — no
    coroutine — matching the sync Python query client. ``runtime_checkable`` so a config field
    could hold it opaque under ``arbitrary_types_allowed`` (the same posture ``transport`` uses).
    """

    def execute(
        self, sql: str, params: Sequence[object] | None = None
    ) -> DbExecuteResult:
        """Execute SQL with optional positional params and return the neutral result."""
        ...
