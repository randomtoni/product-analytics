"""The config-selected receiver factory (E19-S3) — the WRITE-side twin of the query factory.

``create_receiver_from_config`` is the single ergonomic top-level entry for self-host writes: a
``warehouse_dsn`` in → a mount-ready :class:`Receiver` out. These tests mirror the query-side
warehouse-selection tests (``test_query_client.py``): the S3 FAKE exec is injected at the
driver-build boundary (``create_default_db_execute``) so selection + construction are proven with NO
real Postgres and no ``warehouse`` extra — the AC's "S3 fake seam, no real Postgres". Python's
default driver loads its extra EAGERLY at construction, so the fake is monkeypatched at that boundary
(per the E17-S4 shipped note) to prove the DSN is read at the boundary without the driver installed.
"""

from __future__ import annotations

import gzip
import json

import pytest
from db_execute_fakes import FakeDbExecute

from analytics_kit import (
    Receiver,
    ReceiverConfig,
    create_receiver_from_config,
)


def _patch_default_db_execute(monkeypatch: pytest.MonkeyPatch) -> FakeDbExecute:
    fake = FakeDbExecute()
    monkeypatch.setattr(
        "analytics_kit.receiver.factory.create_default_db_execute",
        lambda _dsn: fake,
    )
    return fake


def _wire_event(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "uuid": "dd-1",
        "event": "order_placed",
        "distinct_id": "user-1",
        "properties": {"amount": 42},
        "timestamp": "2026-07-08T00:00:00+00:00",
    }
    base.update(overrides)
    return base


def _envelope(batch: list[dict[str, object]]) -> dict[str, object]:
    return {"api_key": "proj-key", "batch": batch, "sent_at": "2026-07-08T12:00:00+00:00"}


def _raw_body(env: dict[str, object]) -> bytes:
    return json.dumps(env).encode("utf-8")


# --- the config carries the same warehouse_dsn field SHAPE as the query config (C symmetry) ---


def test_receiver_config_carries_warehouse_dsn_defaulting_to_none() -> None:
    assert "warehouse_dsn" in ReceiverConfig.model_fields
    assert ReceiverConfig().warehouse_dsn is None
    assert ReceiverConfig(warehouse_dsn="postgresql://localhost/db").warehouse_dsn == (
        "postgresql://localhost/db"
    )


def test_receiver_config_matches_the_query_config_dsn_field_shape() -> None:
    # C symmetry: the receiver config's DSN field name/annotation mirror the query config's — one
    # coherent "here's my Neon" across read and write; no differently-named DSN field is introduced.
    from analytics_kit import QueryClientConfig

    assert (
        ReceiverConfig.model_fields["warehouse_dsn"].annotation
        == QueryClientConfig.model_fields["warehouse_dsn"].annotation
    )


def test_receiver_config_forbids_unknown_keys() -> None:
    # extra="forbid" is preserved (a typo raises loudly, never silently degrades).
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        ReceiverConfig(warehouse_dsnn="postgresql://localhost/db")  # type: ignore[call-arg]


# --- the factory reads warehouse_dsn and builds the DbExecute at the boundary ---------------


def test_from_config_reads_the_dsn_and_builds_the_default_driver(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[str] = []
    fake = FakeDbExecute()

    def _record(dsn: str) -> FakeDbExecute:
        seen.append(dsn)
        return fake

    monkeypatch.setattr(
        "analytics_kit.receiver.factory.create_default_db_execute", _record
    )
    receiver = create_receiver_from_config(
        ReceiverConfig(warehouse_dsn="postgresql://u:p@localhost/analytics")
    )

    assert isinstance(receiver, Receiver)
    # The DSN is read at the boundary and threaded into the S3 driver build (positional arg shape).
    assert seen == ["postgresql://u:p@localhost/analytics"]


def test_the_built_db_execute_is_what_the_returned_receiver_writes_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _patch_default_db_execute(monkeypatch)
    receiver = create_receiver_from_config(
        ReceiverConfig(warehouse_dsn="postgresql://localhost/analytics")
    )

    outcome = receiver.receive(_raw_body(_envelope([_wire_event()])), {})

    # The receiver upserts through the injected fake — proof the factory wired the built DbExecute
    # into the core (not some other seam).
    assert outcome.outcome == "accepted"
    assert len(fake.calls) == 1
    assert fake.calls[0].sql.startswith("INSERT INTO")
    assert fake.calls[0].params is not None
    assert "dd-1" in fake.calls[0].params


def test_a_gzipped_body_decodes_through_the_dsn_built_receiver(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _patch_default_db_execute(monkeypatch)
    receiver = create_receiver_from_config(
        ReceiverConfig(warehouse_dsn="postgresql://localhost/analytics")
    )

    gzipped = gzip.compress(_raw_body(_envelope([_wire_event()])))
    outcome = receiver.receive(gzipped, {"Content-Encoding": "gzip"})

    assert outcome.outcome == "accepted"
    assert len(fake.calls) == 1


# --- the DSN is read at the boundary, NEVER stored on the returned receiver ------------------


def test_the_returned_receiver_holds_only_the_opaque_db_execute_never_the_dsn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _patch_default_db_execute(monkeypatch)
    receiver = create_receiver_from_config(
        ReceiverConfig(warehouse_dsn="postgresql://user:secret@localhost/analytics")
    )

    # A credential-shaped value read at the factory boundary must not be reachable on the working
    # receiver — its only injected field is the opaque exec, never the DSN / secret.
    field_values = list(vars(receiver).values())
    assert fake in field_values
    for value in field_values:
        assert not (isinstance(value, str) and "postgresql://" in value)
        assert not (isinstance(value, str) and "secret" in value)


# --- lazy import proven: constructs with no psycopg / warehouse extra installed --------------


def test_constructs_without_the_warehouse_extra_installed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The default driver loads its extra EAGERLY at construction; the dev env has no `warehouse`
    # extra, so a real build would raise. Monkeypatching the driver-build boundary proves the
    # factory selects + constructs the receiver with nothing installed — the DSN→driver build is
    # confined to that boundary, and neither the factory nor the receiver core imports psycopg.
    import analytics_kit.query.default_db_execute as dbx

    assert dbx._WAREHOUSE_DRIVER_AVAILABLE is False
    _patch_default_db_execute(monkeypatch)
    receiver = create_receiver_from_config(
        ReceiverConfig(warehouse_dsn="postgresql://localhost/analytics")
    )
    assert isinstance(receiver, Receiver)


def test_the_factory_module_imports_without_the_warehouse_extra() -> None:
    # Importing the factory module must not import the driver (the lazy/eager driver import stays at
    # the driver-build boundary, reached only when a receiver is actually built from a DSN).
    import analytics_kit.receiver.factory as factory  # noqa: F401 — the import itself is the assertion


# --- absent warehouse_dsn ⇒ a CLEAR NEUTRAL ERROR naming the missing field -------------------


def test_absent_warehouse_dsn_raises_a_clear_neutral_error_naming_the_field() -> None:
    # NOT a silent no-op: a write receiver has no natural empty-success state, so the factory names
    # the missing field loudly rather than dropping events. Diverges from the query factory's no-op
    # DELIBERATELY (the read/write asymmetry).
    with pytest.raises(RuntimeError, match=r"warehouse_dsn"):
        create_receiver_from_config(ReceiverConfig())


def test_the_absent_dsn_error_is_transport_and_vendor_free_and_builds_no_driver(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    built: list[str] = []

    def _record(dsn: str) -> FakeDbExecute:
        built.append(dsn)
        return FakeDbExecute()

    monkeypatch.setattr("analytics_kit.receiver.factory.create_default_db_execute", _record)

    with pytest.raises(RuntimeError) as excinfo:
        create_receiver_from_config(ReceiverConfig())

    message = str(excinfo.value)
    # Names the missing field; carries no vendor / no HTTP status vocabulary.
    assert "warehouse_dsn" in message
    assert "posthog" not in message.lower()
    for status in ("200", "400", "500"):
        assert status not in message
    # The write-side diverges from the query no-op: no driver is built, no receiver returned.
    assert built == []


def test_an_empty_string_dsn_is_present_and_still_builds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Selection is by PRESENCE (`is not None`), mirroring the query rung — an explicitly-supplied
    # empty string is present, so it is threaded to the driver build (the driver decides its own
    # validity), not rejected as absent.
    seen: list[str] = []

    def _record(dsn: str) -> FakeDbExecute:
        seen.append(dsn)
        return FakeDbExecute()

    monkeypatch.setattr("analytics_kit.receiver.factory.create_default_db_execute", _record)

    receiver = create_receiver_from_config(ReceiverConfig(warehouse_dsn=""))

    assert isinstance(receiver, Receiver)
    assert seen == [""]


# --- neutrality: named by role, no vendor leak ----------------------------------------------


def test_factory_and_config_are_named_by_role_not_vendor() -> None:
    surface = (
        ReceiverConfig.__name__ + " " + create_receiver_from_config.__name__
    ).lower()
    assert "posthog" not in surface
    assert "warehouse_dsn" in ReceiverConfig.model_fields  # a role, not a vendor
