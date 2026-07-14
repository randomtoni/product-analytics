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
# `plan` (string) and `tier` (number) are DECLARED event props, so the typed view projects a `plan` /
# `tier` column and a breakdown on either passes the E21-S5 SQL-gen declared-key guard. `tier` is the
# §4c half-(2) numeric proof — its `numeric::text` render is asserted end-to-end below.
TAXONOMY = define_taxonomy(
    {
        "events": {
            "funnel_step_1": {"plan": "string", "tier": "number"},
            "funnel_step_2": {"plan": "string", "tier": "number"},
            "funnel_step_3": {"plan": "string", "tier": "number"},
            "cohort_signup": {"plan": "string", "tier": "number"},
            "return_order": {},
            "page_loaded": {"plan": "string", "tier": "number"},
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
    # step-0 (funnel_step_1) carries the breakdown props: `plan` anchors the funnel breakdown group
    # (pro={A,C}, free={B,D}); `tier` is the numeric prop the trend breakdown proves renders as text.
    funnel_events = [
        _ev("funnel_step_1", "A", "2026-01-05T10:00:00Z", {"plan": "pro", "tier": 42}),
        _ev("funnel_step_2", "A", "2026-01-05T11:00:00Z", {"plan": "pro"}),
        _ev("funnel_step_3", "A", "2026-01-05T12:00:00Z"),
        _ev("funnel_step_1", "B", "2026-01-05T10:00:00Z", {"plan": "free", "tier": 7}),
        _ev("funnel_step_3", "B", "2026-01-05T11:00:00Z"),
        _ev("funnel_step_2", "B", "2026-01-05T12:00:00Z", {"plan": "free"}),
        _ev("funnel_step_1", "C", "2026-01-05T10:00:00Z", {"plan": "pro", "tier": 42}),
        _ev("funnel_step_2", "C", "2026-01-06T10:00:01Z", {"plan": "pro"}),
        _ev("funnel_step_1", "D", "2026-01-05T10:00:00Z", {"plan": "free", "tier": 7}),
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
    # cohort_signup carries `plan` — the retention breakdown group is anchored at the cohort event:
    # pro={R1,R3}, free={R2,R4}. In W0's own period only R1 (pro) returns, so p0[pro]=1, p0[free]=0.
    w0 = "2026-01-05"  # Monday
    retention_events = [
        _ev("cohort_signup", "R1", "2026-01-05T09:00:00Z", {"plan": "pro"}),
        _ev("return_order", "R1", "2026-01-05T12:00:00Z"),  # W0 (own period)
        _ev("return_order", "R1", "2026-01-12T12:00:00Z"),  # W1
        _ev("return_order", "R1", "2026-01-19T12:00:00Z"),  # W2
        _ev("cohort_signup", "R2", "2026-01-05T09:00:00Z", {"plan": "free"}),
        _ev("return_order", "R2", "2026-01-12T12:00:00Z"),  # W1 only — proves p0=0 for R2
        _ev("cohort_signup", "R3", "2026-01-05T09:00:00Z", {"plan": "pro"}),  # never returns
        _ev("cohort_signup", "R4", "2026-01-05T09:00:00Z", {"plan": "free"}),
        _ev("return_order", "R4", "2026-01-26T12:00:00Z"),  # W3, past periods-1 -> no grid cell
    ]

    # A returner who was NEVER in the cohort must be excluded (the cells CTE inner-joins cohort).
    non_cohort_returner = [
        _ev("return_order", "X1", "2026-01-05T12:00:00Z"),  # returns in W0 but no cohort_signup
    ]

    # E21-S5 RE-ADDS the BREAKDOWN scenario E21-S3 descoped (the Defect 3 fix): all three breakdown
    # builders now group on the typed view column `("<key>")::text` over `events_typed` (never raw
    # `properties`), so a breakdown trend/funnel/retention runs to completion on real Postgres. The
    # funnel/retention seeds above carry a DECLARED `plan` breakdown prop; the trend seeds carry a
    # DECLARED `tier` NUMBER prop for the numeric `::text` proof. Breakdown assertions are below.

    # now()-relative trend/unique_count smoke: page_loaded by two actors inside a 1-day window. The
    # `tier` NUMBER prop is the §4c half-(2) proof: a numeric breakdown key renders via Postgres
    # `numeric::text` to '42'/'7' (not '42.0'/Decimal) end-to-end. T1's two rows carry tier=42, T2's
    # one row tier=7 → breakdown-by-tier: total {'42': 2, '7': 1}.
    trend_events = [
        _ev("page_loaded", "T1", _iso_minutes_ago(30), {"tier": 42}),
        _ev("page_loaded", "T1", _iso_minutes_ago(20), {"tier": 42}),
        _ev("page_loaded", "T2", _iso_minutes_ago(10), {"tier": 7}),
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

    # (The breakdown trend/funnel/retention scenarios — E21-S5's Defect 3 fix — are asserted in
    # Step 3b below, grouping on the typed view column over real Postgres.)

    # Trend + unique_count smoke (now()-relative window). page_loaded: 3 total rows, 2 unique actors.
    trend = query.trend(TrendSpec(event="page_loaded", aggregation="total", window=Duration(1, "day")))
    assert sum(row.value for row in trend.rows) == 3
    unique = query.unique_count(UniqueCountSpec(event="page_loaded", window=Duration(1, "day")))
    assert sum(row.value for row in unique.rows) == 2

    # raw_query over the consumer's own schema — a neutral column-keyed result from real Postgres.
    # cohort_signup rows: R1,R2,R3,R4 = 4 cohort_signup events.
    raw = query.raw_query("SELECT count(*)::int AS n FROM events WHERE event = 'cohort_signup'")
    assert raw.rows[0]["n"] == 4

    # --- Step 3b: the E21-S5 BREAKDOWN scenarios (Defect 3 fix, RE-ADDED) on real Postgres --------
    # Each groups on the typed view column `("<key>")::text` — NO `column "properties" does not exist`.

    # Funnel breakdown by `plan` (anchored at funnel_step_1): pro={A,C}, free={B,D}. Only A (pro)
    # reaches step 2; B,D (free) reach step 1; C (pro) falls out at step 1's boundary. Per group:
    #   pro:  step0={A,C}=2, step1={A}=1, step2={A}=1
    #   free: step0={B,D}=2, step1={B,D}=2  (no actor reaches step 2 → the walk emits no free/step-2
    #                                        breakdown row; the group's rows stop at the reached step)
    funnel_bd = query.funnel(
        FunnelSpec(
            steps=["funnel_step_1", "funnel_step_2", "funnel_step_3"],
            within=Duration(1, "day"),
            breakdown="plan",
        )
    )
    by_group_step = {(row.breakdown, row.step): row.count for row in funnel_bd.rows}
    assert by_group_step[("pro", 0)] == 2
    assert by_group_step[("pro", 1)] == 1
    assert by_group_step[("pro", 2)] == 1
    assert by_group_step[("free", 0)] == 2
    assert by_group_step[("free", 1)] == 2
    # The free group never reaches step 2 — no free/step-2 row is emitted (the walk drives the groups).
    assert ("free", 2) not in by_group_step
    # Both declared breakdown groups are present, each rendered as a Postgres text string.
    assert {"pro", "free"} <= {row.breakdown for row in funnel_bd.rows}

    # Retention breakdown by `plan` (anchored at cohort_signup): pro={R1,R3}, free={R2,R4}. In W0's
    # own period, only R1 (pro) returns → p0[pro]=1, p0[free]=0.
    retention_bd = query.retention(
        RetentionSpec(
            cohort_event="cohort_signup",
            return_event="return_order",
            periods=3,
            granularity="week",
            breakdown="plan",
        )
    )
    w0_bd = {
        (row.breakdown, row.period_index): row.value
        for row in retention_bd.rows
        if row.cohort == w0
    }
    assert w0_bd[("pro", 0)] == 1  # {R1}
    assert w0_bd[("free", 0)] == 0  # R2 returns only in W1 → own-period edge
    assert {row.breakdown for row in retention_bd.rows} == {"pro", "free"}

    # Trend breakdown by the `tier` NUMBER prop — the §4c half-(2) proof. Postgres renders
    # `numeric::text` as '42'/'7' (never '42.0'/Decimal) end-to-end. page_loaded totals per group:
    # tier=42 → 2 rows (T1×2), tier=7 → 1 row (T2×1).
    trend_bd = query.trend(
        TrendSpec(event="page_loaded", aggregation="total", window=Duration(1, "day"), breakdown="tier")
    )
    total_by_tier: dict[str | None, float] = {}
    for row in trend_bd.rows:
        total_by_tier[row.breakdown] = total_by_tier.get(row.breakdown, 0) + row.value
    assert total_by_tier == {"42": 2, "7": 1}
    # HALF (2): the numeric key rendered to the EXACT string '42' — not '42.0', not a Decimal repr.
    assert "42" in total_by_tier and "42.0" not in total_by_tier
    assert all(isinstance(row.breakdown, str) for row in trend_bd.rows)

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
