"""E21-S3 — the E1 end-to-end zero-egress acceptance test (the self-host cycle CAPSTONE).

Drives the FULL self-host loop against a REAL Postgres (>=16): migrate -> capture via the E19
receiver -> query via the warehouse-selected client -> evaluate E20 static flags — asserting
(1) ZERO HTTP egress (a recording transport whose log is EMPTY of any PostHog-shaped path) AND
(2) results provably from the consumer's own Postgres (the funnel/retention counts equal what the
receiver wrote). This two-sided proof is the behavioral-neutrality gate the fake-backed suites
cannot give: count-faithfulness against a real SQL engine, not a mirror. The parity twin of the TS
``e2e-zero-egress.test.ts`` — the SAME loop, the SAME seeded scenarios, the SAME asserted counts.

The needs-Postgres tier: ``@pytest.mark.needs_postgres`` (registered in ``pyproject.toml``) deselects
the whole test in the fast inner loop and runs it when opted into (``-m needs_postgres``); a
``skipif(not DATABASE_URL)`` safety net makes a mis-run skip rather than error.

Isolation is a THROWAWAY DATABASE per run (not a search_path'd schema): the default driver opens a
fresh connection per execute with no session hook, and the database name in the DSN path is the one
routing piece every driver parses natively — no brittle libpq ``options`` passthrough whose silent
fallback to ``public`` would contaminate the count assertions. The two language trees run against the
same container in separate databases, zero shared namespace.
"""

from __future__ import annotations

import gzip
import json
import os
import uuid
from collections.abc import Iterator
from typing import Any, cast
from urllib.parse import urlparse, urlunparse

import pytest

from analytics_kit import (
    Accepted,
    Duration,
    FeatureFlagDefinition,
    FlagClientConfig,
    FunnelSpec,
    QueryClientConfig,
    ReceiverConfig,
    RetentionSpec,
    TrendSpec,
    UniqueCountSpec,
    build_migration_sql,
    create_flag_client,
    create_query_client,
    create_receiver_from_config,
    define_taxonomy,
)

_DATABASE_URL = os.environ.get("DATABASE_URL")

pytestmark = [
    pytest.mark.needs_postgres,
    pytest.mark.skipif(not _DATABASE_URL, reason="DATABASE_URL unset — no real database available"),
]

# The self-host taxonomy — the funnel steps + the event/prop names the count scenarios seed against.
TAXONOMY = define_taxonomy(
    {
        "events": {
            "funnel_step_1": {"plan": "string"},
            "funnel_step_2": {"plan": "string"},
            "funnel_step_3": {},
            "cohort_signup": {"plan": "string"},
            "return_order": {},
            "page_loaded": {},
        },
        "traits": {"plan": "string"},
    }
)

# The neutral static flag definitions a self-host consumer authors — a 100%-rollout boolean flag and a
# disabled one, evaluated entirely in-process (no definition fetch, no /flags/ round-trip).
STATIC_DEFINITIONS: list[FeatureFlagDefinition] = [
    {
        "key": "new-checkout",
        "enabled": True,
        "conditions": [{"property_filters": [], "rollout_percentage": 100}],
    },
    {"key": "legacy-banner", "enabled": False, "conditions": []},
]

# The PostHog-shaped paths the recording log must be EMPTY of (per the epic zero-egress note).
_POSTHOG_SHAPED = ("/api/projects/", "/query/", "/flags/", "/batch/")


class _RecordingTransport:
    """A transport that FAILS the test if it is ever called — the zero-egress guard. Under the
    self-host config the warehouse rung wins ahead of the HTTP query ladder (no HTTP query adapter is
    constructed) and the static/local-only flag adapter is fetch-inert (constructed, but its seeded
    poller has no endpoint). We assert ``calls == []`` and fail loudly if a wire path is contacted."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def send(self, url: str, method: str, headers: dict[str, str], body: str | None = None) -> Any:
        self.calls.append((method, url))
        raise AssertionError(
            f"egress attempted ({method} {url}) — a self-host config must make no HTTP call"
        )


def _psycopg() -> Any:
    import psycopg

    return psycopg


def _dsn_for_database(base: str, database: str) -> str:
    """The DSN pointed at the throwaway database — its path segment is the per-run db, so every
    per-call connection the default driver opens (receiver-write + query-read) resolves
    ``events``/``events_typed`` there."""
    parsed = urlparse(base)
    return urlunparse(parsed._replace(path=f"/{database}"))


def _admin_execute(sql: str) -> None:
    """Run a single admin statement (CREATE/DROP DATABASE) on the DSN's own database, autocommit —
    CREATE/DROP DATABASE cannot run inside a transaction."""
    psycopg = _psycopg()
    conn = psycopg.connect(cast("str", _DATABASE_URL), autocommit=True)
    try:
        conn.execute(sql)
    finally:
        conn.close()


def _db_execute(dsn: str, sql: str) -> list[tuple[Any, ...]]:
    """Run a statement against the throwaway database and return its rows (empty for non-SELECT)."""
    psycopg = _psycopg()
    conn = psycopg.connect(dsn, autocommit=True)
    try:
        cursor = conn.execute(sql)
        return list(cursor.fetchall()) if cursor.description is not None else []
    finally:
        conn.close()


def _event_count(dsn: str) -> int:
    rows = _db_execute(dsn, "SELECT count(*)::int AS n FROM events")
    return int(rows[0][0])


@pytest.fixture()
def scoped_dsn() -> Iterator[str]:
    """A fresh throwaway database migrated with the shipped E17 migration; dropped at teardown."""
    database = f"e21s3_{uuid.uuid4().hex}"
    _admin_execute(f"CREATE DATABASE {database}")
    dsn = _dsn_for_database(cast("str", _DATABASE_URL), database)
    # buildMigrationSql emits `CREATE TABLE IF NOT EXISTS events` + `CREATE OR REPLACE VIEW
    # events_typed` — the multi-statement string runs verbatim into the throwaway database.
    _db_execute(dsn, build_migration_sql(TAXONOMY))
    try:
        yield dsn
    finally:
        # Every DbExecute connection is per-call and already closed; WITH (FORCE) evicts any stray
        # session so the drop cannot fail.
        _admin_execute(f"DROP DATABASE IF EXISTS {database} WITH (FORCE)")


def _ev(
    event: str, distinct_id: str, timestamp: str, properties: dict[str, Any] | None = None
) -> dict[str, Any]:
    row: dict[str, Any] = {"uuid": str(uuid.uuid4()), "event": event, "distinct_id": distinct_id, "timestamp": timestamp}
    if properties is not None:
        row["properties"] = properties
    return row


def _batch_body(batch: list[dict[str, Any]]) -> tuple[bytes, dict[str, str]]:
    """Build a capture batch body exactly as the server transport POSTs it: `{api_key, batch,
    sent_at}`, gzipped with `Content-Encoding: gzip` (the receiver conditionally decompresses)."""
    envelope = {"api_key": "self-host", "batch": batch, "sent_at": "2026-01-05T10:00:00.000Z"}
    body = gzip.compress(json.dumps(envelope).encode("utf-8"))
    return body, {"content-encoding": "gzip"}


def _iso_minutes_ago(minutes: int) -> str:
    from datetime import datetime, timedelta, timezone

    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()


def test_full_loop_zero_egress_and_counts_provably_from_postgres(scoped_dsn: str) -> None:
    query_transport = _RecordingTransport()
    flag_transport = _RecordingTransport()

    # --- Step 2: POST a capture batch through the E19 receiver -> the `events` table --------------
    receiver = create_receiver_from_config(ReceiverConfig(warehouse_dsn=scoped_dsn))

    # Funnel (steps funnel_step_1 -> _2 -> _3, within 1 day; all step-0 at 10:00 so t0 is shared).
    # Each step takes min(timestamp) STRICTLY after the PRIOR step's matched `reached_at` and
    # <= t0 + within (inclusive upper bound). Disjoint event names from every other scenario so the
    # GLOBAL funnel query counts only these actors — no cross-contamination.
    #  A  full completion in order and in window                    -> reaches step 2
    #  B  step_3@11:00 precedes its step_2@12:00 reach              -> reaches step 1 only
    #  C  step_2 at t0+1day+1s, past the inclusive <= bound        -> reaches step 0 only
    #  D  partial (step_2, never step_3)                            -> reaches step 1
    funnel_events = [
        _ev("funnel_step_1", "A", "2026-01-05T10:00:00Z", {"plan": "pro"}),
        _ev("funnel_step_2", "A", "2026-01-05T11:00:00Z", {"plan": "pro"}),
        _ev("funnel_step_3", "A", "2026-01-05T12:00:00Z"),
        _ev("funnel_step_1", "B", "2026-01-05T10:00:00Z", {"plan": "free"}),
        _ev("funnel_step_3", "B", "2026-01-05T11:00:00Z"),
        _ev("funnel_step_2", "B", "2026-01-05T12:00:00Z", {"plan": "free"}),
        _ev("funnel_step_1", "C", "2026-01-05T10:00:00Z", {"plan": "pro"}),
        _ev("funnel_step_2", "C", "2026-01-06T10:00:01Z", {"plan": "pro"}),
        _ev("funnel_step_1", "D", "2026-01-05T10:00:00Z", {"plan": "free"}),
        _ev("funnel_step_2", "D", "2026-01-05T10:30:00Z", {"plan": "free"}),
    ]

    # Retention (cohort cohort_signup -> return return_order, weekly, 3 periods). 2026-01-05 is a
    # Monday -> ISO week bucket W0 = 2026-01-05. period_index 0 = the cohort's OWN week (returns AT the
    # cohort bucket, NOT the base cohort size). All cohort actors below sign up in W0.
    #   R1: returns W0 + W1 + W2                  -> p0,p1,p2 all retained
    #   R2: returns W1 ONLY (never its own week)  -> p0=0 (own-period edge), p1 retained
    #   R3: no return                             -> contributes to no cell
    #   R4: returns W3 (past periods-1=2)         -> out-of-window: contributes to NOTHING
    # Distinct returners per W0 cell (no breakdown): p0={R1}=1, p1={R1,R2}=2, p2={R1}=1.
    w0 = "2026-01-05"  # Monday
    retention_events = [
        _ev("cohort_signup", "R1", "2026-01-05T09:00:00Z"),
        _ev("return_order", "R1", "2026-01-05T12:00:00Z"),  # W0 (own period)
        _ev("return_order", "R1", "2026-01-12T12:00:00Z"),  # W1
        _ev("return_order", "R1", "2026-01-19T12:00:00Z"),  # W2
        _ev("cohort_signup", "R2", "2026-01-05T09:00:00Z"),
        _ev("return_order", "R2", "2026-01-12T12:00:00Z"),  # W1 only — proves p0=0 for R2
        _ev("cohort_signup", "R3", "2026-01-05T09:00:00Z"),  # never returns
        _ev("cohort_signup", "R4", "2026-01-05T09:00:00Z"),
        _ev("return_order", "R4", "2026-01-26T12:00:00Z"),  # W3, past periods-1 -> no grid cell
    ]

    # A returner who was NEVER in the cohort must be excluded (the cells CTE inner-joins cohort).
    non_cohort_returner = [
        _ev("return_order", "X1", "2026-01-05T12:00:00Z"),  # returns in W0 but no cohort_signup
    ]

    # NOTE — the retention BREAKDOWN scenario is deliberately DESCOPED from E1 (architect-ruled,
    # 2026-07-14). The E1 real-Postgres run surfaced a genuine E18 defect: all three breakdown walk
    # builders emit `properties ->> '<key>'` FROM the typed view `events_typed`, which the E17 view
    # generator does NOT expose (it projects only base columns + declared typed prop columns). So every
    # breakdown query fails on the real engine with `column "properties" does not exist`, in BOTH
    # trees — a contract-violating SQL-generation defect (WAREHOUSE-SCHEMA-CONTRACT.md line 72) that
    # needs its own story (architect consult + cross-tree SQL-gen change + E18 fixture rewrite),
    # beyond S3's locked "test-infra + S1-driver-fix" scope. The MANDATED count-faithfulness (>=1
    # funnel + >=1 retention adversarial scenario) is fully proven by the funnel + non-breakdown
    # retention scenarios above, green on real Postgres.

    # now()-relative trend/unique_count smoke: page_loaded by two actors inside a 1-day window.
    trend_events = [
        _ev("page_loaded", "T1", _iso_minutes_ago(30)),
        _ev("page_loaded", "T1", _iso_minutes_ago(20)),
        _ev("page_loaded", "T2", _iso_minutes_ago(10)),
    ]

    all_events = [
        *funnel_events,
        *retention_events,
        *non_cohort_returner,
        *trend_events,
    ]
    body, headers = _batch_body(all_events)

    outcome = receiver.receive(body, headers)
    assert isinstance(outcome, Accepted)
    assert outcome.accepted == len(all_events)
    assert _event_count(scoped_dsn) == len(all_events)

    # Idempotency: re-POSTing the SAME batch leaves the count unchanged (ON CONFLICT (uuid) DO NOTHING).
    repeat = receiver.receive(body, headers)
    assert isinstance(repeat, Accepted)
    assert repeat.accepted == len(all_events)
    assert _event_count(scoped_dsn) == len(all_events)

    # --- Step 3: query via the warehouse-selected client (the warehouse rung, DSN present) ---------
    query = create_query_client(
        QueryClientConfig(
            warehouse_dsn=scoped_dsn,
            taxonomy=TAXONOMY,
            transport=cast("Any", query_transport),
        )
    )

    # Funnel count-faithfulness (window-from-step-0 + boundary + out-of-order + partial).
    funnel = query.funnel(
        FunnelSpec(
            steps=["funnel_step_1", "funnel_step_2", "funnel_step_3"],
            within=Duration(1, "day"),
        )
    )
    by_step = {row.step: row for row in funnel.rows}
    assert by_step[0].count == 4  # A,B,C,D reached step 0
    assert by_step[1].count == 3  # A,B,D reached step 1; C fell out at the inclusive boundary
    assert by_step[2].count == 1  # only A reached step 2 (strictly after its step-1 reach)
    assert by_step[0].event == "funnel_step_1"
    assert by_step[2].event == "funnel_step_3"
    assert by_step[2].conversion_rate == pytest.approx(1 / 4)  # 0.25

    # Retention count-faithfulness (period_index 0 = the cohort's own period; dense grid; bounded).
    retention = query.retention(
        RetentionSpec(
            cohort_event="cohort_signup",
            return_event="return_order",
            periods=3,
            granularity="week",
        )
    )
    w0_cells = [row for row in retention.rows if row.cohort == w0]
    cell_by_period = {row.period_index: row.value for row in w0_cells}
    assert cell_by_period[0] == 1  # {R1}; R2 returns only in W1 (own-period edge)
    assert cell_by_period[1] == 2  # {R1,R2}
    assert cell_by_period[2] == 1  # {R1}; R4's W3 return is out-of-window and lands on no cell
    # Dense grid: exactly periods {0,1,2} present, never a gap or a phantom period 3 from R4.
    assert {row.period_index for row in w0_cells} == {0, 1, 2}
    assert len(w0_cells) == 3

    # (Retention breakdown scenario DESCOPED — see the seeding note above; Defect 3 follow-up.)

    # Trend + unique_count smoke (now()-relative window). page_loaded: 3 total rows, 2 unique actors.
    trend = query.trend(TrendSpec(event="page_loaded", aggregation="total", window=Duration(1, "day")))
    assert sum(row.value for row in trend.rows) == 3
    unique = query.unique_count(UniqueCountSpec(event="page_loaded", window=Duration(1, "day")))
    assert sum(row.value for row in unique.rows) == 2

    # raw_query over the consumer's own schema — a neutral column-keyed result from real Postgres.
    # cohort_signup rows: R1,R2,R3,R4 = 4 cohort_signup events.
    raw = query.raw_query("SELECT count(*)::int AS n FROM events WHERE event = 'cohort_signup'")
    assert raw.rows[0]["n"] == 4

    # --- Step 4: evaluate E20 static flags local-only (no definition/flag fetch) -------------------
    flags = create_flag_client(
        FlagClientConfig(
            key="self-host",
            static_definitions=[dict(d) for d in STATIC_DEFINITIONS],  # type: ignore[misc]
            only_evaluate_locally=True,
            transport=cast("Any", flag_transport),
        )
    )
    try:
        result = flags.evaluate({"distinct_id": "A"})
        assert result.get_flag("new-checkout") is True
        assert result.get_flag("legacy-banner") is False
        assert result.degraded is False
    finally:
        cast("Any", flags).stop()

    # --- Step 5: the two-sided proof -------------------------------------------------------------
    # (1) Selection proof (strong form): the query transport was never reached and the static/local-
    #     only flag adapter is fetch-inert — both recording logs are EMPTY.
    assert query_transport.calls == []
    assert flag_transport.calls == []
    for _method, url in [*query_transport.calls, *flag_transport.calls]:
        for shape in _POSTHOG_SHAPED:
            assert shape not in url
    # (2) Provenance proof: the queried counts equal what the receiver wrote — the data round-tripped
    #     through the consumer's own Postgres (asserted throughout via the funnel/retention counts).
    assert _event_count(scoped_dsn) == len(all_events)
