"""Real-shape query probe — the ONE genuine inbound-wire boundary decodes over a real socket.

Points the query client's config-supplied endpoint at a local-loopback HTTP server returning a
canned real-shaped response body, and asserts the client decodes it into the neutral
``QueryResult``/``QueryColumn`` shape (the Pydantic-validated inbound boundary). No live warehouse
— a loopback drops in because the endpoint IS config-supplied (``QueryClientConfig.query_endpoint``,
the parity rule).

The probe routes through the PRODUCTION entry ``create_query_client(config)`` — with ``personal_key``
+ ``query_endpoint`` set it selects the real ``HttpQueryAdapter`` and its default stdlib
``_UrllibQueryTransport`` opens a REAL socket to the loopback. The loopback handler serves the
COMPOSED path ``/api/projects/<project_id>/query/`` (NOT the bare root — ``http_adapter.py:125-126``,
``308-309`` compose ``query_endpoint + /api/projects/{project_id}/query/``), requires
``Authorization: Bearer <personal_key>``, and returns an IMMEDIATE result envelope (no
``query_status``), which takes the inline branch and skips the poll loop entirely — so no sleep is
needed.

Ground-truth (SOURCE, no live call): the query wire is posthog-python's query endpoint; the neutral
surface confines every wire token (query kinds, the endpoint template, the Bearer scheme) to the
``_WIRE_*`` constants in ``http_adapter.py`` — none of that appears on ``QueryResult``/``QueryColumn``
or the specs, which carry business primitives only. The probe asserts the decoded shape is the
neutral one, not the wire one.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest

from analytics_kit import (
    QueryClientConfig,
    QueryColumn,
    QueryResult,
    TrendSpec,
    create_query_client,
)
from analytics_kit.query.client import Duration

PROJECT_ID = "proj-42"
PERSONAL_KEY = "phx_read_key"


class _QueryLoopbackServer:
    """A real localhost server returning a canned real-shaped query response on the composed path."""

    def __init__(self, response_body: dict[str, Any]) -> None:
        self.requests: list[dict[str, Any]] = []
        self._response = json.dumps(response_body).encode("utf-8")
        recorder = self

        class _Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length)
                recorder.requests.append(
                    {
                        "path": self.path,
                        "authorization": self.headers.get("Authorization"),
                        "body": json.loads(raw.decode("utf-8")) if raw else None,
                    }
                )
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(recorder._response)

            def log_message(self, *_args: Any) -> None:
                pass

        self._server = HTTPServer(("127.0.0.1", 0), _Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def host(self) -> str:
        address, port = self._server.server_address[:2]
        host = address.decode() if isinstance(address, bytes) else address
        return f"http://{host}:{port}"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


# A canned IMMEDIATE (non-query_status) result envelope: cell-array rows zipped by the columns list.
_CANNED_RESPONSE = {
    "results": [["2026-07-01", 12], ["2026-07-02", 34]],
    "columns": ["day", "count"],
    "types": ["DateTime", "UInt64"],
    "is_cached": False,
}


@pytest.fixture
def query_server() -> Iterator[_QueryLoopbackServer]:
    server = _QueryLoopbackServer(_CANNED_RESPONSE)
    try:
        yield server
    finally:
        server.close()


def _client(host: str) -> Any:
    return create_query_client(
        QueryClientConfig(
            query_endpoint=host,
            personal_key=PERSONAL_KEY,
            project_id=PROJECT_ID,
        )
    )


def test_query_client_decodes_a_real_loopback_response_into_neutral_query_result(
    query_server: _QueryLoopbackServer,
) -> None:
    client = _client(query_server.host)
    result = client.trend(
        TrendSpec(event="pageview", aggregation="total", window=Duration(value=7, unit="day"))
    )

    # The decoded shape is the NEUTRAL QueryResult, Pydantic-validated at the inbound boundary.
    assert isinstance(result, QueryResult)
    assert result.rows == [
        {"day": "2026-07-01", "count": 12},
        {"day": "2026-07-02", "count": 34},
    ]
    assert result.columns == [
        QueryColumn(name="day", type="DateTime"),
        QueryColumn(name="count", type="UInt64"),
    ]
    assert result.from_cache is False
    assert isinstance(result.generated_at, str)


def test_query_request_hits_the_composed_project_scoped_path_with_bearer_auth(
    query_server: _QueryLoopbackServer,
) -> None:
    client = _client(query_server.host)
    client.trend(
        TrendSpec(event="pageview", aggregation="total", window=Duration(value=7, unit="day"))
    )

    assert len(query_server.requests) == 1
    request = query_server.requests[0]
    # The handler must serve the COMPOSED path, not the bare root (http_adapter.py:125-126, 308-309).
    assert request["path"] == f"/api/projects/{PROJECT_ID}/query/"
    assert request["authorization"] == f"Bearer {PERSONAL_KEY}"


def test_query_probe_body_carries_no_dollar_or_vendor_tokens_on_the_neutral_result(
    query_server: _QueryLoopbackServer,
) -> None:
    # The neutral RESULT the consumer receives carries no wire/dialect/vendor vocabulary — the
    # $-free/vendor-free invariant on the read side (wire kinds stay confined to _WIRE_* constants).
    client = _client(query_server.host)
    result = client.trend(
        TrendSpec(event="signup", aggregation="unique", window=Duration(value=30, unit="day"))
    )
    dumped = result.model_dump_json().lower()
    assert "$" not in dumped
    assert "posthog" not in dumped
    assert "hogql" not in dumped
