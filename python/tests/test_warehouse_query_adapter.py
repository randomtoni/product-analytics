"""The warehouse query adapter — the typed-stub bar-A proof.

This is the story's whole reason to exist: a SECOND query backend satisfies the SAME neutral
``AnalyticsQueryClient`` Protocol as the HTTP adapter, with ZERO change to the Protocol (bar A —
provider-swap is one adapter, zero consumer change). The consolidated conformance test feeds BOTH
adapters through the shipped ``_conforms`` type-level sink (mypy proves satisfaction without
subclassing), making "two adapters, one Protocol" explicit and co-located. The stub itself does
not compute — every primitive raises a neutral not-implemented error, never a live connection.
"""

from __future__ import annotations

import inspect

import pytest

from analytics_kit import (
    Duration,
    FunnelSpec,
    RetentionSpec,
    TrendSpec,
    UniqueCountSpec,
    WarehouseQueryAdapter,
    create_warehouse_query_adapter,
)
from analytics_kit.query.http_adapter import HttpQueryAdapter
from test_query_client import _conforms


# --- bar A: two adapters, one Protocol, zero interface change ----------------------------


def test_warehouse_adapter_conforms_to_the_query_protocol_structurally() -> None:
    # The bar-A proof: the warehouse stub satisfies AnalyticsQueryClient by SHAPE alone — mypy
    # proves it at the _conforms sink, no subclassing, ZERO change to the PY5-S1 Protocol.
    adapter = WarehouseQueryAdapter()
    _conforms(adapter)
    from analytics_kit import AnalyticsQueryClient

    assert AnalyticsQueryClient not in type(adapter).__mro__


def test_both_query_adapters_satisfy_one_protocol_unchanged() -> None:
    # Consolidated bar A: the HTTP adapter AND the warehouse adapter — two independent shapes —
    # both pass through the same _conforms sink with zero interface change between them.
    http_adapter = HttpQueryAdapter(
        query_endpoint="https://query.example",
        personal_key="k",
        project_id="1",
    )
    warehouse_adapter = WarehouseQueryAdapter()
    _conforms(http_adapter)
    _conforms(warehouse_adapter)


# --- each primitive is a sync typed stub that does not compute ---------------------------


def test_every_primitive_raises_a_neutral_not_implemented_error() -> None:
    adapter = WarehouseQueryAdapter()
    with pytest.raises(NotImplementedError, match="warehouse query adapter is not yet implemented"):
        adapter.funnel(FunnelSpec(steps=["a", "b"], within=Duration(1, "day")))
    with pytest.raises(NotImplementedError, match="warehouse query adapter is not yet implemented"):
        adapter.retention(
            RetentionSpec(cohort_event="a", return_event="b", periods=3, granularity="day")
        )
    with pytest.raises(NotImplementedError, match="warehouse query adapter is not yet implemented"):
        adapter.trend(TrendSpec(event="a", aggregation="total", window=Duration(7, "day")))
    with pytest.raises(NotImplementedError, match="warehouse query adapter is not yet implemented"):
        adapter.unique_count(UniqueCountSpec(event="a", window=Duration(7, "day")))
    with pytest.raises(NotImplementedError, match="warehouse query adapter is not yet implemented"):
        adapter.raw_query("select 1")


def test_every_primitive_is_sync_not_a_coroutine() -> None:
    # The sync def is load-bearing: an async def returns a coroutine (not QueryResult) and would
    # FAIL the _conforms sink — the bar-A proof depends on the sync signature.
    for member in ("funnel", "retention", "trend", "unique_count", "raw_query"):
        assert not inspect.iscoroutinefunction(getattr(WarehouseQueryAdapter, member))


def test_adapter_has_exactly_the_five_protocol_members() -> None:
    members = {name for name in dir(WarehouseQueryAdapter) if not name.startswith("_")}
    assert members == {"funnel", "retention", "trend", "unique_count", "raw_query"}


# --- constructable + exported, but NOT the default selection ----------------------------


def test_create_warehouse_query_adapter_builds_the_adapter() -> None:
    adapter = create_warehouse_query_adapter()
    assert isinstance(adapter, WarehouseQueryAdapter)


def test_warehouse_adapter_is_not_the_factory_default() -> None:
    # create_query_client selects the no-op / HTTP adapter; the warehouse adapter is constructable
    # but never the config-selected default (that selection is a future additive step).
    from analytics_kit import QueryClientConfig, QueryNoop, create_query_client

    assert isinstance(create_query_client(QueryClientConfig()), QueryNoop)
    http_client = create_query_client(
        QueryClientConfig(query_endpoint="https://q.example", personal_key="k")
    )
    assert not isinstance(http_client, WarehouseQueryAdapter)


# --- neutrality: named by role, no vendor / consumer-domain leak -------------------------


def test_adapter_and_export_are_named_by_role_not_vendor() -> None:
    # 'warehouse' is a role, not a vendor; the forbidden set is vendor/dialect tokens.
    assert WarehouseQueryAdapter.__name__ == "WarehouseQueryAdapter"
    assert create_warehouse_query_adapter.__name__ == "create_warehouse_query_adapter"
    surface = (WarehouseQueryAdapter.__name__ + " " + create_warehouse_query_adapter.__name__).lower()
    assert "posthog" not in surface
    assert "hogql" not in surface


def test_documented_sql_mapping_names_no_consumer_event_or_domain() -> None:
    # The per-method SQL mapping is described generically against the typed view — it references
    # the spec fields (spec.steps, spec.window, ...), never a concrete consumer event/domain name.
    import analytics_kit.query.warehouse_adapter as warehouse

    doc = (warehouse.__doc__ or "").lower()
    assert "spec.steps" in doc
    assert "raw_query" in doc
    assert "typed view" in doc
    for leaked in ("signed_up", "activated", "pageview", "checkout"):
        assert leaked not in doc
