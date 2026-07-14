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
from db_execute_fakes import FakeDbExecute

from analytics_kit import (
    Duration,
    FunnelSpec,
    RetentionSpec,
    TrendSpec,
    UniqueCountSpec,
)
from analytics_kit.query.http_adapter import HttpQueryAdapter
from analytics_kit.query.warehouse_adapter import (
    WarehouseQueryAdapter,
    create_warehouse_query_adapter,
)
from test_query_client import _conforms

# The injected DB-execute seam — the S3 reusable fake. In S4 the stub methods still raise before
# ever calling it; it only has to satisfy the required ``db_execute`` kwarg (E18 invokes it).
_FAKE_EXEC = FakeDbExecute()


# --- bar A: two adapters, one Protocol, zero interface change ----------------------------


def test_warehouse_adapter_conforms_to_the_query_protocol_structurally() -> None:
    # The bar-A proof: the warehouse stub satisfies AnalyticsQueryClient by SHAPE alone — mypy
    # proves it at the _conforms sink, no subclassing, ZERO change to the PY5-S1 Protocol.
    adapter = WarehouseQueryAdapter(db_execute=_FAKE_EXEC)
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
    warehouse_adapter = WarehouseQueryAdapter(db_execute=_FAKE_EXEC)
    _conforms(http_adapter)
    _conforms(warehouse_adapter)


# --- each primitive is a sync typed stub that does not compute ---------------------------


def test_every_primitive_raises_a_neutral_not_implemented_error() -> None:
    adapter = WarehouseQueryAdapter(db_execute=_FAKE_EXEC)
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


# --- the adapter REQUIRES an injected DbExecute; two-tier factory (DI + from-config) --------


def test_constructor_requires_a_db_execute() -> None:
    # The adapter's whole reason to exist post-S4 is to hold the injected seam — no "no exec"
    # state. A bare construction is a TypeError (missing required keyword-only argument).
    with pytest.raises(TypeError):
        WarehouseQueryAdapter()  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        create_warehouse_query_adapter()  # type: ignore[call-arg]


def test_from_config_builds_the_adapter_and_reads_the_dsn_at_the_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The config-reading twin: it reads warehouse_dsn, builds the default driver from it, injects
    # it — proven here with the S3 fake at the driver-build boundary (no real Postgres/extra).
    import analytics_kit.query.warehouse_adapter as wh
    from analytics_kit import QueryClientConfig
    from analytics_kit.query.warehouse_adapter import create_warehouse_query_adapter_from_config

    seen: list[str] = []

    def _record(dsn: str) -> FakeDbExecute:
        seen.append(dsn)
        return _FAKE_EXEC

    monkeypatch.setattr(wh, "create_default_db_execute", _record)
    adapter = create_warehouse_query_adapter_from_config(
        QueryClientConfig(warehouse_dsn="postgresql://localhost/analytics")
    )

    assert isinstance(adapter, WarehouseQueryAdapter)
    assert seen == ["postgresql://localhost/analytics"]


def test_adapter_module_imports_without_the_warehouse_extra_installed() -> None:
    # Importing the adapter module must not import the driver (the lazy driver import stays at the
    # driver-build boundary). The dev env has no `warehouse` extra, so a clean import proves it.
    import analytics_kit.query.default_db_execute as dbx

    assert dbx._WAREHOUSE_DRIVER_AVAILABLE is False
    import analytics_kit.query.warehouse_adapter as wh  # noqa: F401 — the import itself is the assertion


# --- constructable + exported, but NOT the default selection ----------------------------


def test_create_warehouse_query_adapter_builds_the_adapter() -> None:
    adapter = create_warehouse_query_adapter(db_execute=_FAKE_EXEC)
    assert isinstance(adapter, WarehouseQueryAdapter)


def test_warehouse_adapter_is_not_selected_without_a_warehouse_dsn() -> None:
    # create_query_client selects the warehouse adapter ONLY when warehouse_dsn is present; an
    # unkeyed config is the no-op, a keyed+endpointed one is the HTTP adapter — neither warehouse.
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
    surface = (
        WarehouseQueryAdapter.__name__ + " " + create_warehouse_query_adapter.__name__
    ).lower()
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
