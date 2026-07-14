"""E18-S5 — the bar-A READ-SIDE capstone, made executable (the Python mirror).

The whole epic exists to re-prove bar A at the row level: the warehouse adapter must return the SAME
neutral rows as the HTTP adapter, so any consumer keying on them survives the provider swap. This
module is that proof — it drives the S1-S4 warehouse builders (via the adapter, through the injected
DB-execute seam) with a SQL-shaped canned ``DbExecuteResult`` per fixture and asserts the produced
neutral rows EQUAL the ``expected_rows`` of the matching ``query_contract_fixtures`` case.

The fixtures' ``wire_results`` are HTTP-engine-nested (parallel ``days``/``data``, per-step objects,
cohort ``values`` arrays) - NOT the warehouse's flat SQL shape. So each SQL-shaped input below is the
FLAT ``DbExecuteResult`` a warehouse SELECT would return for the SAME scenario, authored here; the
assertion is that the warehouse builder flattens it to the SAME ``expected_rows`` the HTTP adapter's
nested normalizer produces. The parity target is ``expected_rows`` (already identical across both
trees' fixtures files, bar the ``conversion_rate``/``period_index`` casing renames); this story adds
the warehouse-side assertion. The mirrored TS suite lives at
``ts/packages/node/src/query/warehouse-row-parity.test.ts``, cell-for-cell.

The fixtures are consumed READ-ONLY - never edited. If a warehouse builder could not reproduce a
fixture's ``expected_rows``, that would be a BUG in the S1-S3 builder, fixed there, never by relaxing
the fixture. (They ship green, so it holds.)
"""

from __future__ import annotations

import json

from db_execute_fakes import FakeDbExecute
from query_contract_fixtures import (
    ENGINE_ROW_FIELD_NAMES,
    funnel_breakdown,
    funnel_event_precedence,
    funnel_plain,
    funnel_zero_first_step,
    retention_cohorts,
    trend_breakdown,
    trend_single_series,
    unique_count_single_series,
)

from analytics_kit import AnalyticsQueryClient
from analytics_kit.query import DbColumn, DbExecuteResult
from analytics_kit.query.client import (
    Duration,
    FunnelSpec,
    RetentionSpec,
    TrendSpec,
    UniqueCountSpec,
)
from analytics_kit.query.warehouse_adapter import create_warehouse_query_adapter


def _adapter_returning(result: DbExecuteResult) -> AnalyticsQueryClient:
    """A warehouse adapter over a fake DB-execute that returns exactly ``result``."""
    return create_warehouse_query_adapter(db_execute=FakeDbExecute(result))


# -- SQL-shaped inputs (the flat rows a warehouse SELECT would return per scenario) -------------
# Each carries the driver-reported ``columns`` schema + positional cells the S1-S3 flat-row builders
# read by column name (bucket/value/breakdown; step_index/event_name/actor_count;
# cohort/period_index/value). The event names in a funnel result's event_name column echo the spec
# steps but are NOT the neutral source of truth (the builder sources ``event`` from ``spec.steps``) -
# except funnel_event_precedence, called out below.

# TREND single series -> trend_single_series.expected_rows (one row per bucket).
_TREND_SINGLE_SQL = DbExecuteResult(
    columns=[DbColumn(name="bucket", type="text"), DbColumn(name="value", type="int8")],
    rows=[["2026-07-01", 12], ["2026-07-02", 30], ["2026-07-03", 7]],
)

# TREND breakdown -> trend_breakdown.expected_rows (a breakdown cell per row, one series per value).
_TREND_BREAKDOWN_SQL = DbExecuteResult(
    columns=[DbColumn(name="bucket"), DbColumn(name="value"), DbColumn(name="breakdown")],
    rows=[
        ["2026-07-01", 8, "pro"],
        ["2026-07-02", 20, "pro"],
        ["2026-07-01", 4, "free"],
        ["2026-07-02", 10, "free"],
    ],
)

# UNIQUE COUNT -> unique_count_single_series.expected_rows (same flat bucket/value shape as trend).
_UNIQUE_COUNT_SQL = DbExecuteResult(
    columns=[DbColumn(name="bucket"), DbColumn(name="value")],
    rows=[["2026-07-01", 140], ["2026-07-02", 165]],
)

# FUNNEL plain -> funnel_plain.expected_rows. The SQL yields (step_index, event_name, actor_count)
# per step; conversion_rate is COMPUTED in the builder (count[step]/count[0]).
_FUNNEL_PLAIN_SQL = DbExecuteResult(
    columns=[
        DbColumn(name="step_index", type="int4"),
        DbColumn(name="event_name", type="text"),
        DbColumn(name="actor_count", type="int8"),
    ],
    rows=[[0, "signed_up", 1000], [1, "order_placed", 620], [2, "document_uploaded", 410]],
)

# FUNNEL zero-first-step -> funnel_zero_first_step.expected_rows. GUARD-CRITICAL: count[0] == 0 =>
# conversion_rate 0 on every step (guarded division, no NaN/inf leak) - computed from these SQL
# counts identically to the HTTP fixture's expected_rows.
_FUNNEL_ZERO_FIRST_STEP_SQL = DbExecuteResult(
    columns=[DbColumn(name="step_index"), DbColumn(name="event_name"), DbColumn(name="actor_count")],
    rows=[[0, "signed_up", 0], [1, "order_placed", 0]],
)

# FUNNEL event precedence -> funnel_event_precedence.expected_rows. NOTE: the warehouse has NO
# custom_name -> name -> action_id wire precedence - per S2, its funnel ``event`` is the step's own
# identity (sourced from ``spec.steps``). So this SQL-shaped input supplies each step's event_name
# column ALREADY carrying the RESOLVED identity the fixture's expected_rows expect ("Renamed Step"/
# "order_placed"/"act_3"), and the funnel spec's ``steps`` carry those same resolved names, which the
# builder passes through. The parity claim here is on the OUTPUT ``event`` values - NOT that the
# warehouse re-derives them via the HTTP precedence rule (it cannot, and does not need to; the row
# contract fixes the OUTPUT, not the derivation path).
_FUNNEL_EVENT_PRECEDENCE_SQL = DbExecuteResult(
    columns=[DbColumn(name="step_index"), DbColumn(name="event_name"), DbColumn(name="actor_count")],
    rows=[[0, "Renamed Step", 500], [1, "order_placed", 250], [2, "act_3", 100]],
)

# FUNNEL breakdown -> funnel_breakdown.expected_rows. One (step_index, event_name, actor_count,
# breakdown) row per (group, step); conversion_rate is per-GROUP (each group's count[0] is that
# group's first step).
_FUNNEL_BREAKDOWN_SQL = DbExecuteResult(
    columns=[
        DbColumn(name="step_index"),
        DbColumn(name="event_name"),
        DbColumn(name="actor_count"),
        DbColumn(name="breakdown"),
    ],
    rows=[
        [0, "signed_up", 800, "pro"],
        [1, "order_placed", 400, "pro"],
        [0, "signed_up", 200, "free"],
        [1, "order_placed", 50, "free"],
    ],
)

# RETENTION -> retention_cohorts.expected_rows. One dense (cohort, period_index, value) cell per row.
# GUARD-CRITICAL: period_index 0 = the cohort's OWN period (the base cohort size), sourced straight
# from the flat cells - identical to the HTTP fixture's expected_rows.
_RETENTION_SQL = DbExecuteResult(
    columns=[
        DbColumn(name="cohort", type="text"),
        DbColumn(name="period_index", type="int4"),
        DbColumn(name="value", type="int8"),
    ],
    rows=[
        ["2026-07-01", 0, 500],
        ["2026-07-01", 1, 310],
        ["2026-07-01", 2, 190],
        ["2026-07-08", 0, 420],
        ["2026-07-08", 1, 250],
        ["2026-07-08", 2, 150],
    ],
)


# -- Row-parity: warehouse-produced rows EQUAL the fixture's expected_rows ----------------------


def test_parity_trend_single_series() -> None:
    result = _adapter_returning(_TREND_SINGLE_SQL).trend(
        TrendSpec(event="order_placed", aggregation="total", window=Duration(7, "day"))
    )
    assert result.rows == trend_single_series.expected_rows


def test_parity_trend_breakdown() -> None:
    result = _adapter_returning(_TREND_BREAKDOWN_SQL).trend(
        TrendSpec(event="order_placed", aggregation="total", window=Duration(7, "day"), breakdown="plan")
    )
    assert result.rows == trend_breakdown.expected_rows


def test_parity_unique_count() -> None:
    result = _adapter_returning(_UNIQUE_COUNT_SQL).unique_count(
        UniqueCountSpec(event="active_reviewers", window=Duration(7, "day"))
    )
    assert result.rows == unique_count_single_series.expected_rows


def test_parity_funnel_plain_computed_conversion_rate() -> None:
    result = _adapter_returning(_FUNNEL_PLAIN_SQL).funnel(
        FunnelSpec(steps=["signed_up", "order_placed", "document_uploaded"], within=Duration(7, "day"))
    )
    assert result.rows == funnel_plain.expected_rows


def test_parity_funnel_zero_first_step_guarded_to_zero() -> None:
    result = _adapter_returning(_FUNNEL_ZERO_FIRST_STEP_SQL).funnel(
        FunnelSpec(steps=["signed_up", "order_placed"], within=Duration(7, "day"))
    )
    assert result.rows == funnel_zero_first_step.expected_rows


def test_parity_funnel_event_precedence_output_is_spec_sourced() -> None:
    # The warehouse funnel ``event`` is spec-sourced (S2), so the spec's ``steps`` carry the SAME
    # resolved identities the fixture's expected_rows expect - the builder passes them through. The
    # parity claim is on the OUTPUT ``event`` values, NOT re-deriving via the HTTP precedence rule.
    result = _adapter_returning(_FUNNEL_EVENT_PRECEDENCE_SQL).funnel(
        FunnelSpec(steps=["Renamed Step", "order_placed", "act_3"], within=Duration(7, "day"))
    )
    assert result.rows == funnel_event_precedence.expected_rows
    assert [row.event for row in result.rows] == [
        row.event for row in funnel_event_precedence.expected_rows
    ]


def test_parity_funnel_breakdown_per_group_conversion_rate() -> None:
    result = _adapter_returning(_FUNNEL_BREAKDOWN_SQL).funnel(
        FunnelSpec(steps=["signed_up", "order_placed"], within=Duration(7, "day"), breakdown="plan")
    )
    assert result.rows == funnel_breakdown.expected_rows


def test_parity_retention_period_index_zero_is_the_cohort() -> None:
    result = _adapter_returning(_RETENTION_SQL).retention(
        RetentionSpec(cohort_event="signed_up", return_event="order_placed", periods=3, granularity="week")
    )
    assert result.rows == retention_cohorts.expected_rows


# -- Computed-field parity, asserted concretely (bar-A "byte-identical by construction") --------


def test_computed_conversion_rate_guarded_matches_http_fixture_values() -> None:
    result = _adapter_returning(_FUNNEL_ZERO_FIRST_STEP_SQL).funnel(
        FunnelSpec(steps=["signed_up", "order_placed"], within=Duration(7, "day"))
    )
    # The guard produces 0 (never NaN/inf) from SQL counts, exactly as the HTTP fixture.
    assert [row.conversion_rate for row in result.rows] == [
        row.conversion_rate for row in funnel_zero_first_step.expected_rows
    ]
    assert [row.conversion_rate for row in result.rows] == [0, 0]


def test_computed_conversion_rate_normal_and_per_group_matches_http_fixture_values() -> None:
    plain = _adapter_returning(_FUNNEL_PLAIN_SQL).funnel(
        FunnelSpec(steps=["signed_up", "order_placed", "document_uploaded"], within=Duration(7, "day"))
    )
    assert [row.conversion_rate for row in plain.rows] == [
        row.conversion_rate for row in funnel_plain.expected_rows
    ]
    assert [row.conversion_rate for row in plain.rows] == [1, 0.62, 0.41]

    grouped = _adapter_returning(_FUNNEL_BREAKDOWN_SQL).funnel(
        FunnelSpec(steps=["signed_up", "order_placed"], within=Duration(7, "day"), breakdown="plan")
    )
    assert [(row.conversion_rate, row.breakdown) for row in grouped.rows] == [
        (row.conversion_rate, row.breakdown) for row in funnel_breakdown.expected_rows
    ]


def test_computed_period_index_zero_is_the_cohort_period() -> None:
    result = _adapter_returning(_RETENTION_SQL).retention(
        RetentionSpec(cohort_event="signed_up", return_event="order_placed", periods=3, granularity="week")
    )
    assert [row.period_index for row in result.rows] == [
        row.period_index for row in retention_cohorts.expected_rows
    ]
    assert [row.period_index for row in result.rows] == [0, 1, 2, 0, 1, 2]
    # The offset-0 cells are the cohorts' own base sizes (500, 420) - sourced from SQL counts,
    # identical to the fixture.
    base_cells = [row.value for row in result.rows if row.period_index == 0]
    assert base_cells == [500, 420]


# -- Seal (leak guard): no ENGINE_ROW_FIELD_NAMES token on any warehouse-produced row -----------
# The warehouse never speaks the engine wire, so this holds trivially - asserted anyway so a future
# regression (e.g. a leaked SQL column alias) fails this gate. Serializes the full QueryResult via
# model_dump_json() (Pydantic v2 recurses into the frozen-dataclass rows). Covers BOTH paths: the
# broken-down inputs (the ones most likely to leak a breakdown_value-style token) AND a plain
# (non-breakdown) output per primitive - the builders share one code path, so sealing both is a
# completeness nicety.


def test_seal_no_engine_row_field_name_on_any_warehouse_row() -> None:
    trend = _adapter_returning(_TREND_BREAKDOWN_SQL).trend(
        TrendSpec(event="order_placed", aggregation="total", window=Duration(7, "day"), breakdown="plan")
    )
    funnel = _adapter_returning(_FUNNEL_BREAKDOWN_SQL).funnel(
        FunnelSpec(steps=["signed_up", "order_placed"], within=Duration(7, "day"), breakdown="plan")
    )
    retention = _adapter_returning(_RETENTION_SQL).retention(
        RetentionSpec(cohort_event="signed_up", return_event="order_placed", periods=3, granularity="week")
    )

    # Plain (non-breakdown) outputs - the same shared builder path, exercised without a breakdown.
    trend_plain = _adapter_returning(_TREND_SINGLE_SQL).trend(
        TrendSpec(event="order_placed", aggregation="total", window=Duration(7, "day"))
    )
    funnel_plain = _adapter_returning(_FUNNEL_PLAIN_SQL).funnel(
        FunnelSpec(steps=["signed_up", "order_placed", "document_uploaded"], within=Duration(7, "day"))
    )
    retention_plain = _adapter_returning(_RETENTION_SQL).retention(
        RetentionSpec(cohort_event="signed_up", return_event="order_placed", periods=3, granularity="week")
    )

    results = (trend, funnel, retention, trend_plain, funnel_plain, retention_plain)
    for result in results:
        dumped = result.model_dump_json()
        for engine_field in ENGINE_ROW_FIELD_NAMES:
            assert engine_field not in dumped, f"engine key {engine_field!r} leaked into {dumped}"
    # A leaked SQL column alias would surface as a dict key in the serialized rows too.
    dumped_rows = json.dumps([json.loads(r.model_dump_json())["rows"] for r in results])
    for engine_field in ENGINE_ROW_FIELD_NAMES:
        assert engine_field not in dumped_rows
