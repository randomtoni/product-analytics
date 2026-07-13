"""The per-primitive wire→neutral-row CONTRACT fixtures (the Python port).

Each fixture pairs a realistic backend insight-response ``results`` payload (the columns-ABSENT
branch — engine-internal, carrying keys like ``breakdown_value``/``average_conversion_time`` the
neutral surface must NOT leak) with the exact neutral rows the adapter's per-primitive normalizer
must produce. These fixtures ARE the documented contract, and they MIRROR the TS reference
``ts/packages/node/src/query/query-contract.fixtures.ts`` cell-for-cell so cross-language parity
is executable, not just asserted in prose: the wire ``results`` payloads copy verbatim and the
expected rows carry the SAME values, with only two casing renames — ``conversionRate`` →
``conversion_rate`` and ``periodIndex`` → ``period_index``. A diff between the two languages'
fixtures IS the parity check.

Non-``test_``-prefixed so pytest does not auto-collect it; the test modules import it (the Python
analog of importing ``query-contract.fixtures.ts``).

The wire shapes are the neutralized insight-response payloads the adapter flattens: trend entries
carry parallel ``days``/``data`` arrays; funnel results are per-step objects (an array-of-arrays
when broken down); retention results are cohort objects with an indexed ``values`` array.
``columns``/``types`` are raw-query-only and are deliberately ABSENT on every fixture here — these
are the structured insight objects, not a SELECT projection.

``count`` on the funnel rows is ``int`` by design (a discrete actor tally) — do NOT "fix" it to
accept floats; ``conversion_rate`` is the one float on the row, and it is COMPUTED, never on the wire.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Generic

from typing_extensions import TypeVar

from analytics_kit import FunnelStepRow, RetentionRow, TrendRow, UniqueCountRow

_TRow = TypeVar("_TRow")


@dataclass(frozen=True)
class WireRowFixture(Generic[_TRow]):
    """One contract case: a wire ``results`` payload paired with its exact expected neutral rows."""

    description: str
    # The ``results`` array exactly as the backend returns it on the columns-absent branch.
    wire_results: list[object]
    expected_rows: list[_TRow]


# -- TREND -------------------------------------------------------------------------------
# Single series: one top-level entry with parallel days[]/data[], one neutral row per bucket.
# label/count/aggregated_value on the wire never surface.

trend_single_series: WireRowFixture[TrendRow] = WireRowFixture(
    description="trend, single series -> one row per (bucket, value)",
    wire_results=[
        {
            "label": "order_placed",
            "days": ["2026-07-01", "2026-07-02", "2026-07-03"],
            "data": [12, 30, 7],
            "count": 49,
            "aggregated_value": 49,
        },
    ],
    expected_rows=[
        TrendRow(bucket="2026-07-01", value=12),
        TrendRow(bucket="2026-07-02", value=30),
        TrendRow(bucket="2026-07-03", value=7),
    ],
)

# Broken-down: one top-level series PER breakdown value, each with its own days/data and a
# breakdown_value — flattened to one row-series per breakdown, the breakdown stringified onto
# every row. The engine-internal breakdown_value key must appear on NO neutral row.

trend_breakdown: WireRowFixture[TrendRow] = WireRowFixture(
    description="trend, breakdown -> one row-series per breakdown_value, breakdown on each row",
    wire_results=[
        {
            "label": "order_placed - pro",
            "breakdown_value": "pro",
            "days": ["2026-07-01", "2026-07-02"],
            "data": [8, 20],
        },
        {
            "label": "order_placed - free",
            "breakdown_value": "free",
            "days": ["2026-07-01", "2026-07-02"],
            "data": [4, 10],
        },
    ],
    expected_rows=[
        TrendRow(bucket="2026-07-01", value=8, breakdown="pro"),
        TrendRow(bucket="2026-07-02", value=20, breakdown="pro"),
        TrendRow(bucket="2026-07-01", value=4, breakdown="free"),
        TrendRow(bucket="2026-07-02", value=10, breakdown="free"),
    ],
)

# -- UNIQUE COUNT ------------------------------------------------------------------------
# unique_count is byte-identical to trend on the wire (same days/data; only the server-side math
# differs) — it shares the trend row shape, but keeps its OWN named row concept (UniqueCountRow).

unique_count_single_series: WireRowFixture[UniqueCountRow] = WireRowFixture(
    description="uniqueCount, single series -> same days/data shape as trend",
    wire_results=[
        {
            "label": "active reviewers",
            "days": ["2026-07-01", "2026-07-02"],
            "data": [140, 165],
        },
    ],
    expected_rows=[
        UniqueCountRow(bucket="2026-07-01", value=140),
        UniqueCountRow(bucket="2026-07-02", value=165),
    ],
)

# -- FUNNEL ------------------------------------------------------------------------------
# Plain funnel: a flat step array. conversion_rate is COMPUTED (count[step]/count[0]), NOT a wire
# field. Event identity resolves via custom_name -> name -> action_id (first present non-empty).
# average_conversion_time/converted_people_url never surface.

funnel_plain: WireRowFixture[FunnelStepRow] = WireRowFixture(
    description="funnel, plain -> step rows with computed conversion_rate (count/count[0])",
    wire_results=[
        {"order": 0, "name": "signed_up", "count": 1000, "average_conversion_time": None, "converted_people_url": "/x/0"},
        {"order": 1, "name": "order_placed", "count": 620, "average_conversion_time": 3600, "converted_people_url": "/x/1"},
        {"order": 2, "name": "document_uploaded", "count": 410, "average_conversion_time": 7200, "converted_people_url": "/x/2"},
    ],
    expected_rows=[
        FunnelStepRow(step=0, event="signed_up", count=1000, conversion_rate=1),
        FunnelStepRow(step=1, event="order_placed", count=620, conversion_rate=0.62),
        FunnelStepRow(step=2, event="document_uploaded", count=410, conversion_rate=0.41),
    ],
)

# count[0] == 0 -> conversion_rate 0 for every step (guarded division, no NaN/Infinity leak).

funnel_zero_first_step: WireRowFixture[FunnelStepRow] = WireRowFixture(
    description="funnel, count[0] == 0 -> conversion_rate 0 on every step (guarded)",
    wire_results=[
        {"order": 0, "name": "signed_up", "count": 0},
        {"order": 1, "name": "order_placed", "count": 0},
    ],
    expected_rows=[
        FunnelStepRow(step=0, event="signed_up", count=0, conversion_rate=0),
        FunnelStepRow(step=1, event="order_placed", count=0, conversion_rate=0),
    ],
)

# Event-identity precedence: custom_name wins over name wins over action_id; the first present
# NON-EMPTY string is the neutral event.

funnel_event_precedence: WireRowFixture[FunnelStepRow] = WireRowFixture(
    description="funnel, event precedence custom_name -> name -> action_id (first non-empty)",
    wire_results=[
        {"order": 0, "custom_name": "Renamed Step", "name": "signed_up", "action_id": "act_1", "count": 500},
        {"order": 1, "custom_name": "", "name": "order_placed", "action_id": "act_2", "count": 250},
        {"order": 2, "name": "", "action_id": "act_3", "count": 100},
    ],
    expected_rows=[
        FunnelStepRow(step=0, event="Renamed Step", count=500, conversion_rate=1),
        FunnelStepRow(step=1, event="order_placed", count=250, conversion_rate=0.5),
        FunnelStepRow(step=2, event="act_3", count=100, conversion_rate=0.2),
    ],
)

# Broken-down funnel: an ARRAY OF ARRAYS — one inner step-array per breakdown group, each step
# carrying breakdown_value. conversion_rate is per-GROUP (each group's count[0] is that group's
# first step), and the breakdown is stringified onto every row.

funnel_breakdown: WireRowFixture[FunnelStepRow] = WireRowFixture(
    description="funnel, array-of-arrays breakdown -> per-group conversion_rate + breakdown on each row",
    wire_results=[
        [
            {"order": 0, "name": "signed_up", "count": 800, "breakdown_value": "pro"},
            {"order": 1, "name": "order_placed", "count": 400, "breakdown_value": "pro"},
        ],
        [
            {"order": 0, "name": "signed_up", "count": 200, "breakdown_value": "free"},
            {"order": 1, "name": "order_placed", "count": 50, "breakdown_value": "free"},
        ],
    ],
    expected_rows=[
        FunnelStepRow(step=0, event="signed_up", count=800, conversion_rate=1, breakdown="pro"),
        FunnelStepRow(step=1, event="order_placed", count=400, conversion_rate=0.5, breakdown="pro"),
        FunnelStepRow(step=0, event="signed_up", count=200, conversion_rate=1, breakdown="free"),
        FunnelStepRow(step=1, event="order_placed", count=50, conversion_rate=0.25, breakdown="free"),
    ],
)

# -- RETENTION ---------------------------------------------------------------------------
# Cohort objects, each with date (cohort start) and an indexed values array where index 0 is the
# cohort itself (period_index 0 = the cohort's own period). One neutral row per (cohort, period).

retention_cohorts: WireRowFixture[RetentionRow] = WireRowFixture(
    description="retention -> one row per (cohort, period_index); period_index 0 = the cohort itself",
    wire_results=[
        {
            "date": "2026-07-01",
            "label": "Week 0",
            "values": [{"count": 500}, {"count": 310}, {"count": 190}],
        },
        {
            "date": "2026-07-08",
            "label": "Week 1",
            "values": [{"count": 420}, {"count": 250}, {"count": 150}],
        },
    ],
    expected_rows=[
        RetentionRow(cohort="2026-07-01", period_index=0, value=500),
        RetentionRow(cohort="2026-07-01", period_index=1, value=310),
        RetentionRow(cohort="2026-07-01", period_index=2, value=190),
        RetentionRow(cohort="2026-07-08", period_index=0, value=420),
        RetentionRow(cohort="2026-07-08", period_index=1, value=250),
        RetentionRow(cohort="2026-07-08", period_index=2, value=150),
    ],
)

# The engine-internal ROW field names a neutral row must NEVER carry. The seal tests serialize the
# returned rows and assert each of these is absent from the output.
ENGINE_ROW_FIELD_NAMES: Final = (
    "breakdown_value",
    "average_conversion_time",
    "aggregation_value",
    "aggregated_value",
    "converted_people_url",
)
