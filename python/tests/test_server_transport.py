"""Tests for the adapter-owned transport + the gzip→POST delivery callback.

These pin the delivery path below the neutral seam: the ``{api_key, batch, sent_at}`` gzipped
POST, the raw-JSON fallback, the no-vendor-host endpoint resolution, the ``Content-Type``/
``Content-Encoding`` wire headers, the injectable :class:`Transport` on the adapter constructor
(default stdlib ``urllib``, never a vendor type), and that gzip+POST run through the transport —
NOT the neutral ``send(str)`` primitive. A fake transport stands in for the network throughout.
"""

from __future__ import annotations

import gzip
import json
from datetime import datetime, timezone

import pytest

from analytics_kit import (
    AnalyticsConfig,
    NeutralResponse,
    ServerAdapter,
    Transport,
    UrllibTransport,
    __version__,
    create_server_analytics,
)
from analytics_kit.neutral_event import NeutralEvent
from analytics_kit.server import transport as transport_module
from analytics_kit.server.transport import create_send_batch, resolve_endpoint


class _FakeTransport:
    """A Transport that records the POST args instead of hitting the network."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, str], bytes]] = []

    def post(self, url: str, headers: dict[str, str], body: bytes) -> NeutralResponse:
        self.calls.append((url, headers, body))
        return NeutralResponse(status=200, body="")


def _event(tag: str = "order_placed") -> NeutralEvent:
    return NeutralEvent(
        event=tag,
        distinct_id="u1",
        dedupe_id="dd-1",
        properties={"amount": 42},
        timestamp=datetime(2026, 7, 8, tzinfo=timezone.utc),
    )


def _decode(headers: dict[str, str], body: bytes) -> dict[str, object]:
    if headers.get("Content-Encoding") == "gzip":
        body = gzip.decompress(body)
    decoded: dict[str, object] = json.loads(body.decode("utf-8"))
    return decoded


# --- endpoint resolution: config host + path, no vendor default -------------------------


def test_resolve_endpoint_joins_host_and_path() -> None:
    config = AnalyticsConfig(ingest_host="https://ingest.example", ingest_path="/custom/")
    assert resolve_endpoint(config) == "https://ingest.example/custom/"


def test_resolve_endpoint_strips_a_trailing_host_slash() -> None:
    config = AnalyticsConfig(ingest_host="https://ingest.example/", ingest_path="/batch/")
    assert resolve_endpoint(config) == "https://ingest.example/batch/"


def test_resolve_endpoint_defaults_the_path_but_never_the_host() -> None:
    config = AnalyticsConfig(ingest_host="https://ingest.example")
    assert resolve_endpoint(config) == "https://ingest.example/batch/"


def test_resolve_endpoint_has_no_vendor_host_default() -> None:
    # An absent ingest_host is a consumer misconfiguration — never a fall-through to a vendor
    # endpoint. The resolved URL carries only the (empty) host + path, nothing vendor.
    url = resolve_endpoint(AnalyticsConfig())
    assert url == "/batch/"
    assert "posthog" not in url.lower()


# --- delivery: {api_key, batch, sent_at} gzipped POST through the transport --------------


def test_delivery_posts_the_batch_envelope_to_the_resolved_endpoint() -> None:
    fake = _FakeTransport()
    config = AnalyticsConfig(key="proj-key", ingest_host="https://ingest.example")
    deliver = create_send_batch(config, fake)

    deliver([_event("a"), _event("b")])

    assert len(fake.calls) == 1
    url, headers, body = fake.calls[0]
    assert url == "https://ingest.example/batch/"
    envelope = _decode(headers, body)
    assert envelope["api_key"] == "proj-key"
    batch = envelope["batch"]
    assert isinstance(batch, list)
    assert [msg["event"] for msg in batch] == ["a", "b"]
    assert "sent_at" in envelope


def test_delivery_gzips_the_body_by_default() -> None:
    fake = _FakeTransport()
    deliver = create_send_batch(
        AnalyticsConfig(key="k", ingest_host="https://ingest.example"), fake
    )

    deliver([_event()])

    _url, headers, body = fake.calls[0]
    assert headers["Content-Type"] == "application/json"
    assert headers["Content-Encoding"] == "gzip"
    # The body is real gzip: it decompresses back to the JSON envelope.
    assert json.loads(gzip.decompress(body).decode("utf-8"))["api_key"] == "k"


def test_delivery_falls_back_to_raw_json_when_gzip_yields_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _FakeTransport()
    monkeypatch.setattr("analytics_kit.server.transport.gzip.compress", lambda *_a, **_k: b"")
    deliver = create_send_batch(
        AnalyticsConfig(key="k", ingest_host="https://ingest.example"), fake
    )

    deliver([_event()])

    _url, headers, body = fake.calls[0]
    assert headers["Content-Type"] == "application/json"
    assert "Content-Encoding" not in headers
    # Raw JSON body — readable without decompression.
    assert json.loads(body.decode("utf-8"))["api_key"] == "k"


def test_delivery_uses_a_missing_key_as_the_empty_api_key() -> None:
    fake = _FakeTransport()
    # create_send_batch is only reached with a key in practice, but guard the empty default.
    deliver = create_send_batch(AnalyticsConfig(ingest_host="https://ingest.example"), fake)

    deliver([_event()])

    _url, headers, body = fake.calls[0]
    assert _decode(headers, body)["api_key"] == ""


# --- injectable transport on the adapter constructor ------------------------------------


def test_adapter_defaults_to_the_stdlib_urllib_transport() -> None:
    adapter = ServerAdapter(version=__version__)
    assert isinstance(adapter.transport, UrllibTransport)


def test_adapter_accepts_an_injected_transport() -> None:
    fake = _FakeTransport()
    adapter = ServerAdapter(version=__version__, transport=fake)
    assert adapter.transport is fake


def test_injected_transport_satisfies_the_protocol_structurally() -> None:
    # A fake with a matching post() satisfies Transport without inheritance — no vendor type.
    fake: Transport = _FakeTransport()
    adapter = ServerAdapter(version=__version__, transport=fake)
    assert adapter.transport is fake


def test_default_urllib_transport_names_no_vendor() -> None:
    adapter = ServerAdapter(version=__version__)
    assert "posthog" not in type(adapter.transport).__name__.lower()


# --- gzip+POST run through the transport, NOT the neutral send(str) primitive ------------


def test_gzip_post_bypasses_the_neutral_send_primitive() -> None:
    # The seam send(str) stays inert (status 0); the real delivery runs through the transport.
    fake = _FakeTransport()
    adapter = ServerAdapter(version=__version__, transport=fake)

    # The neutral string-bodied send is unchanged and untouched by batch delivery.
    response = adapter.send("https://example.invalid", "POST", {}, "{}")
    assert response.status == 0
    assert fake.calls == []

    # The gzipped batch delivery runs entirely through the injected transport.
    deliver = create_send_batch(
        AnalyticsConfig(key="k", ingest_host="https://ingest.example"), fake
    )
    deliver([_event()])
    assert len(fake.calls) == 1


# --- end-to-end wiring: create_server_analytics threads the transport into delivery -------


def test_keyed_provider_delivers_through_the_adapter_transport_in_sync_mode() -> None:
    # sync_mode + flush_at=1 so a single capture delivers inline; then a fake transport can be
    # asserted end to end. We build the provider ourselves to inject the fake transport.
    from analytics_kit.factory import create_analytics
    from analytics_kit.server.adapter import ServerAdapter as SA
    from analytics_kit.server.consumer import BatchConsumer

    fake = _FakeTransport()
    config = AnalyticsConfig(
        key="k", ingest_host="https://ingest.example", sync_mode=True, flush_at=1
    )
    consumer = BatchConsumer(create_send_batch(config, fake), sync_mode=True, flush_at=1)
    adapter = SA(version=__version__, sink=consumer, transport=fake)
    provider = create_analytics(config, adapter)

    provider.capture("u1", "signed_up", {"amount": 5})

    assert len(fake.calls) == 1
    _url, headers, body = fake.calls[0]
    envelope = _decode(headers, body)
    batch = envelope["batch"]
    assert isinstance(batch, list)
    assert batch[0]["event"] == "signed_up"


def test_target_entry_wires_a_default_urllib_transport_onto_the_adapter() -> None:
    provider = create_server_analytics(AnalyticsConfig(key="k", ingest_host="https://x.example"))
    adapter = provider._adapter
    assert isinstance(adapter, ServerAdapter)
    assert isinstance(adapter.transport, UrllibTransport)
    provider.shutdown()  # join the injected consumer's daemon thread (no leak)


# --- _WIRE_* confinement of the transport wire vocabulary --------------------------------


def test_transport_wire_vocab_is_confined_to_module_constants() -> None:
    assert transport_module._WIRE_CONTENT_TYPE == "application/json"
    assert transport_module._WIRE_CONTENT_ENCODING_GZIP == "gzip"
    assert transport_module._WIRE_DEFAULT_INGEST_PATH == "/batch/"
    assert transport_module._WIRE_METHOD_POST == "POST"
