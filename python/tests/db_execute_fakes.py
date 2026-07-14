"""Reusable test double for the DB-execute seam — a shared helper (mirroring the
``query_contract_fixtures`` convention) that S3, S4, and E18 tests import so none of them needs a
real Postgres. It is the concrete proof the seam is injectable.

Importable as ``from db_execute_fakes import FakeDbExecute`` (``tests`` is on ``pythonpath``).
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from analytics_kit.query import DbExecuteResult


@dataclass(frozen=True)
class RecordedExec:
    """One recorded invocation — the SQL and positional params that crossed the seam."""

    sql: str
    params: Sequence[object] | None


class FakeDbExecute:
    """A :class:`~analytics_kit.query.DbExecute` that records every call and returns a canned
    :class:`DbExecuteResult`. Pass a canned result (or a per-call resolver) to drive E18's
    normalization bodies without a driver; ``calls`` is exposed for SQL/params assertions.
    """

    def __init__(
        self,
        canned: DbExecuteResult | Callable[[RecordedExec], DbExecuteResult] | None = None,
    ) -> None:
        self._canned = canned if canned is not None else DbExecuteResult()
        self.calls: list[RecordedExec] = []

    def execute(
        self, sql: str, params: Sequence[object] | None = None
    ) -> DbExecuteResult:
        call = RecordedExec(sql=sql, params=params)
        self.calls.append(call)
        if callable(self._canned):
            return self._canned(call)
        return self._canned


@dataclass
class FakeCursor:
    """A minimal DB-API cursor stand-in for testing the default driver's row/column mapping
    without a live driver — its ``description``/``fetchall`` satisfy the private ``_CursorLike``.
    """

    description: Sequence[Sequence[object]] | None = None
    rows: list[Sequence[object]] = field(default_factory=list)

    def fetchall(self) -> list[Sequence[object]]:
        return self.rows
