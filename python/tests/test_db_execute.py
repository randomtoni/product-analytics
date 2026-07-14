"""Tests for the DB-execute seam, its reusable fake, and the default driver behind the extra."""

from __future__ import annotations

import os
import uuid

import pytest
from db_execute_fakes import FakeCursor, FakeDbExecute, RecordedExec

from analytics_kit.query import (
    DbColumn,
    DbExecute,
    DbExecuteResult,
    DefaultDbExecute,
    create_default_db_execute,
)
from analytics_kit.query import default_db_execute as dbx_mod


def test_db_execute_is_a_runtime_checkable_protocol() -> None:
    # Mirrors the QueryTransport posture: a structural, runtime_checkable Protocol.
    assert isinstance(FakeDbExecute(), DbExecute)


def test_db_execute_result_defaults_to_empty_rows_and_columns() -> None:
    result = DbExecuteResult()
    assert result.rows == []
    assert result.columns == []


def test_db_column_carries_name_and_optional_type() -> None:
    assert DbColumn(name="bucket").type is None
    assert DbColumn(name="bucket", type="timestamptz").type == "timestamptz"


def test_db_execute_result_and_column_are_frozen() -> None:
    with pytest.raises((AttributeError, TypeError)):
        DbColumn(name="x").name = "y"  # type: ignore[misc]
    with pytest.raises((AttributeError, TypeError)):
        DbExecuteResult().rows = [("a",)]  # type: ignore[misc]


def test_fake_satisfies_the_seam_and_returns_its_canned_result() -> None:
    canned = DbExecuteResult(
        rows=[("2026-01-01", 5), ("2026-01-02", 7)],
        columns=[DbColumn(name="bucket", type="timestamptz"), DbColumn(name="value", type="numeric")],
    )
    fake: DbExecute = FakeDbExecute(canned)

    result = fake.execute("SELECT bucket, value FROM analytics_events_typed", [])

    assert result == canned
    assert result.rows[0] == ("2026-01-01", 5)


def test_fake_records_sql_and_params_that_crossed_the_seam() -> None:
    fake = FakeDbExecute()

    fake.execute("SELECT 1")
    fake.execute("SELECT %s", ["x"])

    assert fake.calls == [
        RecordedExec(sql="SELECT 1", params=None),
        RecordedExec(sql="SELECT %s", params=["x"]),
    ]


def test_fake_defaults_to_empty_result_when_uncanned() -> None:
    result = FakeDbExecute().execute("SELECT 1")
    assert result.rows == []
    assert result.columns == []


def test_fake_accepts_a_per_call_resolver() -> None:
    fake = FakeDbExecute(lambda call: DbExecuteResult(rows=[(call.sql,)], columns=[DbColumn(name="echoed")]))

    result = fake.execute("SELECT now()")

    assert result.rows == [("SELECT now()",)]
    assert result.columns == [DbColumn(name="echoed")]


# The lazy-import guard: the driver is NOT installed in the dev env, so the module imported
# cleanly (this test file's imports above prove it) and the flag reflects absence. Constructing
# the default driver without the extra raises a neutral, vendor-generic RuntimeError.
def test_module_imports_without_the_optional_driver_installed() -> None:
    assert dbx_mod._WAREHOUSE_DRIVER_AVAILABLE is False


def test_constructing_the_default_driver_without_the_extra_raises_a_neutral_error() -> None:
    with pytest.raises(RuntimeError, match=r"analytics-kit\[warehouse\]"):
        create_default_db_execute("postgresql://localhost/db")
    with pytest.raises(RuntimeError, match=r"analytics-kit\[warehouse\]"):
        DefaultDbExecute("postgresql://localhost/db")


def test_the_neutral_error_names_no_vendor_or_driver() -> None:
    with pytest.raises(RuntimeError) as excinfo:
        create_default_db_execute("postgresql://localhost/db")
    message = str(excinfo.value).lower()
    assert "psycopg" not in message
    assert "postgres" not in message


# The row/column mapping is exercised over a structural cursor stand-in (no live driver): the
# driver-boundary edge is isolated in `DefaultDbExecute.execute`, so the pure mapper is testable.
def test_default_driver_maps_a_cursor_into_the_neutral_result() -> None:
    cursor = FakeCursor(
        description=[("bucket", 1184), ("value", 1700)],
        rows=[("2026-01-01", 5), ("2026-01-02", 7)],
    )

    result = dbx_mod._result_from_cursor(cursor)

    assert result.rows == [("2026-01-01", 5), ("2026-01-02", 7)]
    assert result.columns == [DbColumn(name="bucket"), DbColumn(name="value")]


def test_default_driver_maps_an_empty_result_but_keeps_its_columns() -> None:
    cursor = FakeCursor(description=[("bucket", 1184)], rows=[])

    result = dbx_mod._result_from_cursor(cursor)

    assert result.rows == []
    assert result.columns == [DbColumn(name="bucket")]


def test_default_driver_tolerates_a_none_description() -> None:
    cursor = FakeCursor(description=None, rows=[])

    result = dbx_mod._result_from_cursor(cursor)

    assert result.columns == []
    assert result.rows == []


# Real-driver conformance the fake-backed tests above structurally cannot cover: a non-RETURNING
# `INSERT ... ON CONFLICT (uuid) DO NOTHING` executed through the REAL DefaultDbExecute against a
# REAL Postgres — the exact write the E19 receiver emits. On such a write the driver leaves
# cursor.description None and produces no result set, so an UNGUARDED fetchall() raises
# ProgrammingError; this proves the guard returns the empty result instead.
#
# Gated on DATABASE_URL truthiness (no marker): inert in the fast gate until a real Postgres DSN
# is supplied — and a set-but-EMPTY DATABASE_URL skips rather than erroring on construction. The
# needs-Postgres test tier/marker is registered separately (S3).
_DATABASE_URL = os.environ.get("DATABASE_URL")

_skip_without_db = pytest.mark.skipif(
    not _DATABASE_URL, reason="DATABASE_URL unset — no real database available"
)


@_skip_without_db
def test_default_driver_returns_empty_result_on_a_non_returning_write() -> None:
    db_execute = create_default_db_execute(_DATABASE_URL)  # type: ignore[arg-type]

    table = f"akit_e21s1_{uuid.uuid4().hex}"
    row_uuid = str(uuid.uuid4())
    sql = (
        f"CREATE TEMP TABLE {table} (uuid uuid UNIQUE NOT NULL, note text);\n"
        f"INSERT INTO {table} (uuid, note) VALUES ('{row_uuid}', 'seed');\n"
        f"INSERT INTO {table} (uuid, note) VALUES ('{row_uuid}', 'conflict') "
        "ON CONFLICT (uuid) DO NOTHING;"
    )

    result = db_execute.execute(sql)

    assert result == DbExecuteResult(rows=[], columns=[])
    assert result.rows == []
    assert result.columns == []


# The write-PERSISTENCE proof the single-call test above structurally cannot give: the driver
# opens a fresh connection PER execute() call and holds no cross-call transaction, so a write only
# counts if it is committed before its connection closes. This writes in one execute() and reads
# back in a SEPARATE execute() — the read runs on a brand-new connection, so a non-zero count can
# only mean the row survived the writing connection's close (i.e. was committed, via autocommit).
# A REAL (non-TEMP) table is mandatory: a TEMP table is connection-scoped and would vanish with
# the per-call connection, so it can never prove cross-connection persistence. Uuid-suffixed to
# avoid cross-run collisions, DROP TABLE in a finally for cleanup.
@_skip_without_db
def test_default_driver_persists_a_write_across_the_per_call_connection() -> None:
    db_execute = create_default_db_execute(_DATABASE_URL)  # type: ignore[arg-type]

    table = f"akit_e21s1_persist_{uuid.uuid4().hex}"
    row_uuid = str(uuid.uuid4())
    try:
        db_execute.execute(f"CREATE TABLE {table} (uuid text primary key)")
        db_execute.execute(
            f"INSERT INTO {table} (uuid) VALUES (%s) ON CONFLICT (uuid) DO NOTHING",
            [row_uuid],
        )

        # A SEPARATE execute() — a brand-new connection. Seeing the row proves it was committed.
        result = db_execute.execute(f"SELECT count(*) FROM {table}")
        assert result.rows == [(1,)]

        # Re-running the same insert is a no-op (ON CONFLICT DO NOTHING) — still exactly one row.
        db_execute.execute(
            f"INSERT INTO {table} (uuid) VALUES (%s) ON CONFLICT (uuid) DO NOTHING",
            [row_uuid],
        )
        recount = db_execute.execute(f"SELECT count(*) FROM {table}")
        assert recount.rows == [(1,)]
    finally:
        db_execute.execute(f"DROP TABLE IF EXISTS {table}")
