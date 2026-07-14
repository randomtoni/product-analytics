"""E21-S2 — the self-host-selection standing gate (E2, protocol-neutrality).

This is the SECOND, orthogonal neutrality gate (the name scan proves observability neutrality; this
proves BEHAVIORAL neutrality). Given a self-host config it asserts, at the SELECTION LEVEL, that the
neutral self-host backends are the ones the factories CONSTRUCT — never the HTTP/wire path. It
consolidates three assertions that already live green in the per-capability suites
(``test_query_client`` / ``test_flag_static_definitions`` / ``test_receiver_from_config``) into ONE
named standing behavioral unit so a regression in ANY rung fails one clearly-named gate.

Selection-level, not URL-string or AST: the strongest form is "the HTTP adapter was never even
constructed" — assert the returned TYPE (and, for flags, that the client cannot reach a URL: its
transport is never called). Fast: fake ``DbExecute`` / recording transport, NO real Postgres, NO
network — runs in the fast inner loop (no ``DATABASE_URL`` needed).

LOAD-BEARING — the TS↔Python driver-import asymmetry. Python's default driver loads its extra
EAGERLY: ``DefaultDbExecute.__init__`` RAISES at construction when ``psycopg`` is absent (the dev env
has no ``warehouse`` extra). So the query + receiver rungs MUST monkeypatch ``create_default_db_execute``
at the driver-build boundary or they ERROR instead of asserting — the exact pattern the shipped
per-capability tests use.
"""

from __future__ import annotations

from typing import Any, cast

import pytest
from db_execute_fakes import FakeDbExecute

from analytics_kit import (
    FeatureFlagDefinition,
    FlagClientConfig,
    FlagContext,
    QueryClientConfig,
    ReceiverConfig,
    Receiver,
    create_flag_client,
    create_query_client,
    create_receiver_from_config,
)
from analytics_kit.flags.adapter import HttpFlagAdapter
from analytics_kit.flags.noop import FlagNoop
from analytics_kit.flags.transport import FlagTransport
from analytics_kit.query.http_adapter import HttpQueryAdapter
from analytics_kit.query.noop import QueryNoop
from analytics_kit.query.warehouse_adapter import WarehouseQueryAdapter

# A fake DSN — never a real Postgres. The driver build is monkeypatched at its boundary so
# selection + construction are proven with no `warehouse` extra installed and no network.
FAKE_DSN = "postgresql://localhost/analytics"

# The neutral static flag definitions a self-host consumer authors — a 100%-rollout boolean flag.
SIMPLE_STATIC: FeatureFlagDefinition = {
    "key": "simple-flag",
    "enabled": True,
    "conditions": [{"property_filters": [], "rollout_percentage": 100}],
}

CONTEXT: FlagContext = {"distinct_id": "distinct_id_0"}


class _RecordingTransport:
    """A transport that FAILS the test if it is ever called — the zero-egress guard. A static-seeded
    local-only client must resolve entirely in-process: no definition fetch, no remote round-trip."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def send(self, url: str, method: str, headers: dict[str, str], body: str | None = None) -> Any:
        self.calls.append((method, url))
        raise AssertionError(
            f"transport was hit ({method} {url}) — a static-seeded client must not egress"
        )


# --- Query rung: warehouse_dsn present ⇒ the warehouse adapter, NOT the HTTP adapter ------------


def test_query_warehouse_dsn_selects_the_warehouse_adapter_not_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Python's default driver is EAGER — monkeypatch the driver-build boundary or construction RAISES.
    fake = FakeDbExecute()
    monkeypatch.setattr(
        "analytics_kit.query.warehouse_adapter.create_default_db_execute",
        lambda _dsn: fake,
    )

    client = create_query_client(QueryClientConfig(warehouse_dsn=FAKE_DSN))

    # Selection-level: the constructed TYPE is the warehouse rung; the HTTP adapter was never built.
    assert isinstance(client, WarehouseQueryAdapter)
    assert not isinstance(client, HttpQueryAdapter)
    assert not isinstance(client, QueryNoop)


def test_query_warehouse_dsn_wins_over_a_full_http_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakeDbExecute()
    monkeypatch.setattr(
        "analytics_kit.query.warehouse_adapter.create_default_db_execute",
        lambda _dsn: fake,
    )

    # Even fully HTTP-configured, presence of the DSN takes precedence — HTTP is never reached.
    client = create_query_client(
        QueryClientConfig(
            warehouse_dsn=FAKE_DSN,
            personal_key="phx_read",
            query_endpoint="https://query.example",
            project_id="42",
        )
    )

    assert isinstance(client, WarehouseQueryAdapter)
    assert not isinstance(client, HttpQueryAdapter)


# --- Flags rung: static definitions ⇒ a local-only client with no reachable flag URL ------------


def test_flags_static_definitions_select_a_local_only_client_that_never_egresses() -> None:
    transport = _RecordingTransport()
    client = create_flag_client(
        FlagClientConfig(
            key="k",
            static_definitions=[dict(SIMPLE_STATIC)],  # type: ignore[list-item]
            only_evaluate_locally=True,
            transport=cast("FlagTransport", transport),
        )
    )
    try:
        # A static-defs config is a real (local) route, so it is NOT downgraded to the no-op.
        assert isinstance(client, HttpFlagAdapter)
        assert not isinstance(client, FlagNoop)

        result = client.evaluate(CONTEXT)

        # Resolved from the seeded snapshot, and the transport was NEVER hit — the local-only client
        # is structurally unable to fetch (no flag/definitions URL): zero fetches, zero /flags/ calls.
        assert result.get_flag("simple-flag") is True
        assert result.degraded is False
        assert transport.calls == []
    finally:
        cast("HttpFlagAdapter", client).stop()


# --- Receiver rung: warehouse_dsn ⇒ a DSN-built DbExecute writer, not an HTTP writer ------------


def test_receiver_from_config_builds_a_dsn_targeted_writer_not_http(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Python's default driver is EAGER — monkeypatch the driver-build boundary or construction RAISES.
    seen: list[str] = []
    fake = FakeDbExecute()

    def _record(dsn: str) -> FakeDbExecute:
        seen.append(dsn)
        return fake

    monkeypatch.setattr(
        "analytics_kit.receiver.factory.create_default_db_execute", _record
    )

    receiver = create_receiver_from_config(ReceiverConfig(warehouse_dsn=FAKE_DSN))

    # Selection-level: the DSN was read at the boundary and threaded into the DSN-built DbExecute —
    # the neutral warehouse writer, not an HTTP transport. The receiver is a mount-ready Receiver.
    assert isinstance(receiver, Receiver)
    assert seen == [FAKE_DSN]
