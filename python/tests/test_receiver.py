"""Tests for the framework-agnostic receiver core — the WRITE side of self-host.

Asserts the upsert SQL + bound params against the E17 reusable fake ``DbExecute`` (NO real
Postgres): the envelope parse, the ``ON CONFLICT (uuid) DO NOTHING`` idempotent upsert, the
receipt-time default (a FIXED instant), gzip vs raw decompress, trait/group nesting persisted
as-is, empty-``properties`` → ``{}``, the empty-batch no-op, and a malformed body → neutral parse
error. Mirrors the TS ``receiver.test.ts`` coverage (parity by shared contract).
"""

from __future__ import annotations

import gzip
import json
from datetime import datetime, timezone

from db_execute_fakes import FakeDbExecute

from analytics_kit.receiver import Accepted, MalformedBody, Receiver

_RAW_HEADERS = {"content-type": "application/json"}
_GZIP_HEADERS = {"content-type": "application/json", "content-encoding": "gzip"}
_FIXED_NOW = datetime(2026, 7, 10, 9, 30, 0, tzinfo=timezone.utc)
_FIXED_NOW_ISO = "2026-07-10T09:30:00+00:00"


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


def _gzip_body(env: dict[str, object]) -> bytes:
    return gzip.compress(json.dumps(env).encode("utf-8"))


# --- envelope parse + upsert SQL/params (raw JSON) --------------------------------------


def test_parses_the_node_batch_envelope_and_upserts_via_on_conflict_do_nothing() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    result = receiver.receive(_raw_body(_envelope([_wire_event()])), _RAW_HEADERS, _FIXED_NOW)

    assert result == Accepted(accepted=1)
    assert len(fake.calls) == 1
    assert fake.calls[0].sql == (
        "INSERT INTO events (distinct_id, event, timestamp, uuid, properties) VALUES "
        "($1, $2, $3, $4, $5) ON CONFLICT (uuid) DO NOTHING"
    )
    assert fake.calls[0].params == [
        "user-1",
        "order_placed",
        "2026-07-08T00:00:00+00:00",
        "dd-1",
        json.dumps({"amount": 42}),
    ]


def test_binds_sql_params_never_string_interpolated() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    receiver.receive(
        _raw_body(_envelope([_wire_event(event="'; DROP TABLE events; --", distinct_id="user-x")])),
        _RAW_HEADERS,
        _FIXED_NOW,
    )

    assert "DROP TABLE" not in fake.calls[0].sql
    assert "user-x" not in fake.calls[0].sql
    assert fake.calls[0].params is not None
    assert "'; DROP TABLE events; --" in fake.calls[0].params


# --- multi-row batch: one statement, placeholders in lockstep ---------------------------


def test_a_multi_event_batch_is_one_statement_with_lockstep_placeholders() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    result = receiver.receive(
        _raw_body(
            _envelope(
                [_wire_event(uuid="a"), _wire_event(uuid="b"), _wire_event(uuid="c")]
            )
        ),
        _RAW_HEADERS,
        _FIXED_NOW,
    )

    assert result == Accepted(accepted=3)
    assert len(fake.calls) == 1
    assert fake.calls[0].sql == (
        "INSERT INTO events (distinct_id, event, timestamp, uuid, properties) VALUES "
        "($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10), ($11, $12, $13, $14, $15) "
        "ON CONFLICT (uuid) DO NOTHING"
    )
    assert fake.calls[0].params is not None
    assert len(fake.calls[0].params) == 15
    assert fake.calls[0].params[5:10] == [
        "user-1",
        "order_placed",
        "2026-07-08T00:00:00+00:00",
        "b",
        json.dumps({"amount": 42}),
    ]


# --- idempotency on uuid ----------------------------------------------------------------


def test_idempotency_the_upsert_carries_on_conflict_do_nothing() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    receiver.receive(_raw_body(_envelope([_wire_event(uuid="retry-key")])), _RAW_HEADERS, _FIXED_NOW)
    receiver.receive(
        _raw_body(_envelope([_wire_event(uuid="retry-key", properties={"amount": 99})])),
        _RAW_HEADERS,
        _FIXED_NOW,
    )

    for call in fake.calls:
        assert "ON CONFLICT (uuid) DO NOTHING" in call.sql


def test_an_intra_batch_duplicate_uuid_is_safe_do_nothing() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    result = receiver.receive(
        _raw_body(_envelope([_wire_event(uuid="dup"), _wire_event(uuid="dup")])),
        _RAW_HEADERS,
        _FIXED_NOW,
    )

    assert result == Accepted(accepted=2)
    assert len(fake.calls) == 1
    assert fake.calls[0].params is not None
    assert len(fake.calls[0].params) == 10
    assert "ON CONFLICT (uuid) DO NOTHING" in fake.calls[0].sql


# --- properties jsonb: verbatim, {} when absent, trait/group nesting persisted as-is ----


def test_properties_binds_verbatim_as_a_json_string() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    receiver.receive(
        _raw_body(_envelope([_wire_event(properties={"plan": "pro", "nested": {"a": 1}})])),
        _RAW_HEADERS,
        _FIXED_NOW,
    )

    assert fake.calls[0].params is not None
    assert fake.calls[0].params[4] == json.dumps({"plan": "pro", "nested": {"a": 1}})


def test_absent_properties_binds_an_empty_json_object_never_null() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    # An event dict WITHOUT a `properties` key (the wire emits it only when present).
    event: dict[str, object] = {
        "uuid": "no-props",
        "event": "e",
        "distinct_id": "u",
        "timestamp": "2026-07-08T00:00:00+00:00",
    }
    receiver.receive(_raw_body(_envelope([event])), _RAW_HEADERS, _FIXED_NOW)

    assert fake.calls[0].params is not None
    assert fake.calls[0].params[4] == "{}"


def test_trait_group_keys_stay_nested_inside_properties_no_column_named_after_them() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    trait_props: dict[str, object] = {"set": {"plan": "pro"}, "set_once": {"signup": "2026"}}
    group_props: dict[str, object] = {
        "group_type": "company",
        "group_key": "acme",
        "group_set": {"seats": 10},
    }

    receiver.receive(
        _raw_body(
            _envelope(
                [
                    _wire_event(uuid="t", event="set_traits", properties=trait_props),
                    _wire_event(uuid="g", event="set_group_traits", properties=group_props),
                ]
            )
        ),
        _RAW_HEADERS,
        _FIXED_NOW,
    )

    assert "INSERT INTO events (distinct_id, event, timestamp, uuid, properties)" in fake.calls[0].sql
    for key in ("set", "set_once", "group_type", "group_key", "group_set"):
        assert f", {key}," not in fake.calls[0].sql
        assert f"({key}," not in fake.calls[0].sql
    assert fake.calls[0].params is not None
    assert fake.calls[0].params[4] == json.dumps(trait_props)
    assert fake.calls[0].params[9] == json.dumps(group_props)


# --- server-receipt-time default --------------------------------------------------------


def test_a_wire_event_omitting_timestamp_persists_at_server_receipt_time() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    e1: dict[str, object] = {"uuid": "no-ts-1", "event": "e", "distinct_id": "u", "properties": {}}
    e2: dict[str, object] = {"uuid": "no-ts-2", "event": "e", "distinct_id": "u", "properties": {}}
    receiver.receive(_raw_body(_envelope([e1, e2])), _RAW_HEADERS, _FIXED_NOW)

    assert fake.calls[0].params is not None
    # Both events omitting timestamp take the SAME receipt instant — one arrival per batch.
    assert fake.calls[0].params[2] == _FIXED_NOW_ISO
    assert fake.calls[0].params[7] == _FIXED_NOW_ISO


def test_a_wire_event_carrying_timestamp_uses_it_verbatim() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    has_ts = _wire_event(uuid="has-ts", timestamp="2020-01-01T00:00:00+00:00")
    no_ts: dict[str, object] = {"uuid": "no-ts", "event": "e", "distinct_id": "u", "properties": {}}
    receiver.receive(_raw_body(_envelope([has_ts, no_ts])), _RAW_HEADERS, _FIXED_NOW)

    assert fake.calls[0].params is not None
    assert fake.calls[0].params[2] == "2020-01-01T00:00:00+00:00"
    assert fake.calls[0].params[7] == _FIXED_NOW_ISO


def test_receipt_time_defaults_to_a_real_now_when_no_instant_is_passed() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    before = datetime.now(timezone.utc)
    no_ts: dict[str, object] = {"uuid": "x", "event": "e", "distinct_id": "u", "properties": {}}
    receiver.receive(_raw_body(_envelope([no_ts])), _RAW_HEADERS)
    after = datetime.now(timezone.utc)

    assert fake.calls[0].params is not None
    bound = datetime.fromisoformat(fake.calls[0].params[2])  # type: ignore[arg-type]
    assert before <= bound <= after


# --- conditional decompress -------------------------------------------------------------


def test_gunzips_the_body_when_content_encoding_gzip_is_present() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    result = receiver.receive(_gzip_body(_envelope([_wire_event()])), _GZIP_HEADERS, _FIXED_NOW)

    assert result == Accepted(accepted=1)
    assert fake.calls[0].params is not None
    assert fake.calls[0].params[3] == "dd-1"


def test_content_encoding_lookup_is_case_insensitive() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    result = receiver.receive(
        _gzip_body(_envelope([_wire_event()])), {"Content-Encoding": "GZIP"}
    )

    assert result == Accepted(accepted=1)


def test_parses_raw_utf8_json_when_content_encoding_absent() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    result = receiver.receive(_raw_body(_envelope([_wire_event()])), _RAW_HEADERS, _FIXED_NOW)

    assert result == Accepted(accepted=1)


# --- empty batch + malformed body -------------------------------------------------------


def test_a_valid_empty_batch_is_a_no_op_success_with_zero_db_calls() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    result = receiver.receive(_raw_body(_envelope([])), _RAW_HEADERS, _FIXED_NOW)

    assert result == Accepted(accepted=0)
    assert len(fake.calls) == 0


def test_a_malformed_body_yields_a_neutral_parse_error_and_never_calls_the_db() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    result = receiver.receive(b"not json at all", _RAW_HEADERS, _FIXED_NOW)

    assert result == MalformedBody()
    assert len(fake.calls) == 0


def test_a_valid_json_body_that_is_not_the_batch_envelope_is_a_neutral_parse_error() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    result = receiver.receive(
        json.dumps({"token": "x", "data": []}).encode("utf-8"), _RAW_HEADERS, _FIXED_NOW
    )

    assert result == MalformedBody()
    assert len(fake.calls) == 0


def test_undecodable_gzip_yields_a_neutral_parse_error() -> None:
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    result = receiver.receive(b"not gzip", _GZIP_HEADERS, _FIXED_NOW)

    assert result == MalformedBody()
    assert len(fake.calls) == 0


# --- opaque write result ----------------------------------------------------------------


def test_treats_the_db_execute_result_as_opaque() -> None:
    # The fake returns its default empty result (the non-RETURNING-write contract). The receiver
    # never reads rows off it; accepted reflects the batch size regardless of the (empty) result.
    fake = FakeDbExecute()
    receiver = Receiver(fake)

    result = receiver.receive(
        _raw_body(_envelope([_wire_event(uuid="1"), _wire_event(uuid="2")])),
        _RAW_HEADERS,
        _FIXED_NOW,
    )

    assert result == Accepted(accepted=2)
