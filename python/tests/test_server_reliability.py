"""Tests for the server reliability + lifecycle slice — the R1 hardening carried cross-language.

These pin the delivery-side guarantees that ride on the PY4-S2 queue + PY4-S3 transport:

* retry classification — a transient failure (``0``/``408``/``429``/``5xx``) retries within the
  fixed-delay budget; a non-413 ``4xx`` is a permanent rejection (dropped, not retried);
* fetch-failure normalization at the transport boundary — a RAISING transport never propagates a
  raw exception onto the neutral surface; it surfaces as status ``0``, is retried, then given up;
* 413-halving — a ``413`` halves ``max_batch_size`` and re-sends the SAME records smaller, and a
  single record that still ``413``\\ s is dropped so the loop terminates;
* ``flush()`` — force-drains and blocks, leaving the adapter usable;
* ``shutdown()`` — sets the quiesce latch FIRST (a mid-drain capture is inert), drains within a
  configurable timeout, settles deterministically (never raises) on timeout, and joins the thread.

The retry-delay wait is injected throughout so no test sleeps real seconds; a fake transport (which
returns scripted statuses or raises) stands in for the network — never a real backend.
"""

from __future__ import annotations

import threading
import time

import pytest

from analytics_kit import AnalyticsConfig, NeutralResponse, create_server_analytics
from analytics_kit.neutral_event import NeutralEvent
from analytics_kit.server.consumer import BatchConsumer
from analytics_kit.server.transport import create_send_batch


def _event(tag: str) -> NeutralEvent:
    return NeutralEvent(event=tag, distinct_id="u1", dedupe_id=tag)


def _config(**overrides: object) -> AnalyticsConfig:
    base: dict[str, object] = {"key": "k", "ingest_host": "https://ingest.example"}
    base.update(overrides)
    return AnalyticsConfig(**base)  # type: ignore[arg-type]


class _ScriptedTransport:
    """A Transport that returns a scripted status per POST (last status repeats when exhausted).

    Records the number of records in every posted batch, so a test can assert how the 413-halving
    re-slices the SAME records without decompressing the body.
    """

    def __init__(self, statuses: list[int]) -> None:
        self._statuses = statuses
        self.calls = 0
        self.posted_sizes: list[int] = []

    def post(self, url: str, headers: dict[str, str], body: bytes) -> NeutralResponse:
        idx = min(self.calls, len(self._statuses) - 1)
        status = self._statuses[idx]
        self.calls += 1
        return NeutralResponse(status=status, body="")


class _SizeAwareTransport:
    """A Transport whose status is decided from the batch size, so 413-halving can be driven by the
    per-slice record count rather than a fixed script."""

    def __init__(self, status_for_size: dict[int, int], default: int = 200) -> None:
        self._status_for_size = status_for_size
        self._default = default
        self.posted_sizes: list[int] = []

    def post(self, url: str, headers: dict[str, str], body: bytes) -> NeutralResponse:
        import gzip
        import json

        raw = gzip.decompress(body) if headers.get("Content-Encoding") == "gzip" else body
        size = len(json.loads(raw.decode("utf-8"))["batch"])
        self.posted_sizes.append(size)
        return NeutralResponse(status=self._status_for_size.get(size, self._default), body="")


class _RaisingTransport:
    """A Transport that RAISES a raw client exception on every POST — the negative control for
    fetch-failure normalization. It must never propagate out of the delivery path."""

    class _RawError(Exception):
        """Stands in for a raw ``urllib``/connection/DNS error the neutral surface must not see."""

    def __init__(self) -> None:
        self.calls = 0

    def post(self, url: str, headers: dict[str, str], body: bytes) -> NeutralResponse:
        self.calls += 1
        raise self._RawError("connection refused")


class _CountingWait:
    """Records each injected retry-delay wait instead of sleeping."""

    def __init__(self) -> None:
        self.waits: list[float] = []

    def __call__(self, seconds: float) -> None:
        self.waits.append(seconds)


# --- retry classification: transient retries within budget -------------------------------


@pytest.mark.parametrize("status", [0, 408, 429, 500, 503, 599])
def test_transient_status_retries_within_the_fixed_budget(status: int) -> None:
    transport = _ScriptedTransport([status])
    wait = _CountingWait()
    deliver = create_send_batch(_config(retry_count=3, retry_delay=3.0), transport, wait=wait)

    deliver([_event("e0")])

    # 1 initial attempt + retry_count retries = 4 total; 3 fixed-delay waits between them.
    assert transport.calls == 4
    assert wait.waits == [3.0, 3.0, 3.0]


def test_transient_then_success_stops_retrying() -> None:
    transport = _ScriptedTransport([503, 503, 200])
    wait = _CountingWait()
    deliver = create_send_batch(_config(retry_count=5), transport, wait=wait)

    deliver([_event("e0")])

    # Two transient failures, then a 200 accept: 3 attempts, 2 waits, no further retries.
    assert transport.calls == 3
    assert len(wait.waits) == 2


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
def test_non_413_4xx_is_dropped_not_retried(status: int) -> None:
    transport = _ScriptedTransport([status])
    wait = _CountingWait()
    deliver = create_send_batch(_config(retry_count=3), transport, wait=wait)

    deliver([_event("e0")])

    # A permanent rejection: exactly one attempt, no retry, no wait — the record is a clean drop.
    assert transport.calls == 1
    assert wait.waits == []


def test_retry_count_zero_makes_a_single_attempt() -> None:
    transport = _ScriptedTransport([503])
    wait = _CountingWait()
    deliver = create_send_batch(_config(retry_count=0), transport, wait=wait)

    deliver([_event("e0")])

    assert transport.calls == 1
    assert wait.waits == []


# --- fetch-failure normalization at the transport boundary (the negative control) --------


def test_raising_transport_does_not_propagate_and_is_retried_then_given_up() -> None:
    transport = _RaisingTransport()
    wait = _CountingWait()
    deliver = create_send_batch(_config(retry_count=3), transport, wait=wait)

    # The raised raw exception is normalized to status 0 at the boundary — no exception escapes.
    deliver([_event("e0")])

    # Status 0 is transient: retried across the whole budget (4 attempts), then given up cleanly.
    assert transport.calls == 4
    assert wait.waits == [3.0, 3.0, 3.0]


def test_raising_transport_never_leaks_through_flush_or_shutdown() -> None:
    transport = _RaisingTransport()
    wait = _CountingWait()
    consumer = BatchConsumer(
        create_send_batch(_config(retry_count=1), transport, wait=wait),
        flush_at=1000,
        flush_interval=1000.0,
    )
    try:
        consumer.enqueue(_event("e0"))
        # Neither force-draining nor quiescing surfaces the raw transport exception.
        consumer.flush()
        assert transport.calls >= 1
    finally:
        consumer.shutdown()


# --- 413-halving: halve max_batch_size, re-send the SAME records --------------------------


def test_413_halves_max_batch_size_and_resends_the_same_records() -> None:
    # A 4-record slice 413s, a 2-record slice 413s, a 1-record slice succeeds: 4 → 2+2 → 1+1+1+1.
    transport = _SizeAwareTransport({4: 413, 2: 413}, default=200)
    deliver = create_send_batch(_config(max_batch_size=4), transport, wait=_CountingWait())

    deliver([_event(f"e{i}") for i in range(4)])

    # The first over-large POST, then halved re-slices — the records are re-sent, never dropped.
    assert transport.posted_sizes[0] == 4
    assert 2 in transport.posted_sizes
    assert transport.posted_sizes.count(1) == 4  # every record ultimately delivered at size 1


def test_413_is_not_counted_as_a_retry_backoff_status() -> None:
    # A single 413 (terminal drop) makes exactly one POST — 413 does not consume the retry budget.
    transport = _ScriptedTransport([413])
    wait = _CountingWait()
    deliver = create_send_batch(_config(retry_count=3, max_batch_size=1), transport, wait=wait)

    deliver([_event("e0")])

    assert transport.calls == 1  # not retried as a transient
    assert wait.waits == []


# --- 413 terminal case: a single record that still 413s is dropped, rest continue --------


def test_single_record_413_is_dropped_and_the_rest_continue() -> None:
    # e0 alone always 413s (its size-1 slice), the rest (size-1) accept: e0 is dropped, no loop.
    posted_events: list[str] = []

    class _PerRecordTransport:
        def post(self, url: str, headers: dict[str, str], body: bytes) -> NeutralResponse:
            import gzip
            import json

            raw = gzip.decompress(body) if headers.get("Content-Encoding") == "gzip" else body
            batch = json.loads(raw.decode("utf-8"))["batch"]
            tags = [msg["event"] for msg in batch]
            posted_events.extend(tags)
            return NeutralResponse(status=413 if tags == ["e0"] else 200, body="")

    deliver = create_send_batch(_config(max_batch_size=1), _PerRecordTransport(), wait=_CountingWait())

    deliver([_event("e0"), _event("e1"), _event("e2")])

    # e0 is dropped after its single-record 413 (no infinite loop); e1/e2 are delivered.
    assert posted_events.count("e0") == 1  # attempted once, then dropped — never re-looped
    assert "e1" in posted_events
    assert "e2" in posted_events


def test_all_records_413_terminally_drop_without_looping() -> None:
    # Every size-1 slice 413s: all records are dropped one by one and the loop terminates.
    transport = _ScriptedTransport([413])
    deliver = create_send_batch(_config(max_batch_size=1), transport, wait=_CountingWait())

    deliver([_event("e0"), _event("e1")])

    assert transport.calls == 2  # one terminal 413 per record, then done — no loop


# --- flush(): force-drain, block, stay usable --------------------------------------------


def test_flush_force_drains_bypassing_the_trigger_and_stays_usable() -> None:
    transport = _ScriptedTransport([200])
    consumer = BatchConsumer(
        create_send_batch(_config(), transport, wait=_CountingWait()),
        flush_at=1000,  # size trigger unreachable
        flush_interval=1000.0,  # interval trigger far off
    )
    try:
        consumer.enqueue(_event("e0"))
        consumer.flush()  # force-drain despite the trigger not firing
        assert transport.calls == 1

        # Still usable: a second capture + flush delivers again (flush did not quiesce).
        consumer.enqueue(_event("e1"))
        consumer.flush()
        assert transport.calls == 2
    finally:
        consumer.shutdown()


def test_flush_on_the_unkeyed_no_op_returns_immediately() -> None:
    provider = create_server_analytics(AnalyticsConfig())  # no key ⇒ whole-stack no-op
    provider.flush()  # returns without building or draining a queue
    provider.shutdown()


# --- shutdown(): quiesce-first, timeout-drain, settle-not-raise, join --------------------


def test_shutdown_drains_the_buffer_then_quiesces() -> None:
    transport = _ScriptedTransport([200])
    consumer = BatchConsumer(
        create_send_batch(_config(), transport, wait=_CountingWait()),
        flush_at=1000,
        flush_interval=1000.0,
    )
    consumer.enqueue(_event("e0"))

    consumer.shutdown()

    assert transport.calls == 1  # the buffered event was drained on shutdown
    assert consumer._thread is None  # the daemon thread is joined/stopped


def test_shutdown_quiesces_first_so_a_mid_drain_capture_is_inert() -> None:
    # The capture racing in DURING the drain must be dropped — the no-re-arm invariant. We race it
    # from inside the delivery callback (which runs while shutdown holds the drain).
    delivered: list[str] = []
    consumer_box: dict[str, BatchConsumer] = {}

    def deliver(batch: list[NeutralEvent]) -> None:
        for event in batch:
            delivered.append(event.event)
        # A capture arriving mid-drain (after shutdown latched) must be inert — not re-buffered.
        consumer_box["c"].enqueue(_event("mid-drain"))

    consumer = BatchConsumer(deliver, flush_at=1000, flush_interval=1000.0)
    consumer_box["c"] = consumer
    consumer.enqueue(_event("e0"))

    consumer.shutdown()

    assert delivered == ["e0"]  # the mid-drain capture never delivered — quiesce held
    assert consumer._thread is None


def test_post_shutdown_capture_is_inert() -> None:
    transport = _ScriptedTransport([200])
    consumer = BatchConsumer(
        create_send_batch(_config(), transport, wait=_CountingWait()),
        flush_at=1000,
        flush_interval=1000.0,
    )
    consumer.shutdown()

    consumer.enqueue(_event("after"))  # dropped — the consumer is quiesced
    consumer.flush()

    assert transport.calls == 0  # nothing delivered after shutdown; no re-arm


def test_shutdown_settles_deterministically_on_timeout_without_raising(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # A slow backend + a backlog too large to fully drain within the timeout forces the race:
    # each single-record delivery sleeps a little, and the deadline trips between drains. shutdown
    # must SETTLE (log + return, process not hung), never raise; the undrained events are left
    # unsent by design. sync_mode ⇒ no daemon thread, so shutdown drives the drain deterministically.
    def deliver(batch: list[NeutralEvent]) -> None:
        time.sleep(0.02)  # a slow per-batch delivery so a backlog overruns the tiny timeout

    consumer = BatchConsumer(
        deliver, sync_mode=True, flush_at=1000, max_batch_size=1, shutdown_timeout=0.05
    )
    for i in range(100):
        consumer.enqueue(_event(f"e{i}"))  # 100 events × 0.02s ≫ the 0.05s shutdown timeout

    with caplog.at_level("WARNING", logger="analytics_kit"):
        consumer.shutdown()  # settles on the timeout — no raise, no hang

    assert consumer._stopped is True
    assert consumer._buffer_size() > 0  # undrained residue left unsent by design (process not hung)
    assert any("some events may not have been sent" in r.message for r in caplog.records)


def test_async_shutdown_join_timeout_settles_without_raising_and_leaks_no_thread() -> None:
    # The async-mode counterpart: a REAL daemon thread is mid-in-flight delivery when shutdown() is
    # called with a timeout that expires before the delivery returns. shutdown() must settle within
    # ~the timeout (join times out, not hung) and not raise; the blocked daemon is orphaned by
    # design. A single in-flight delivery cannot be interrupted (the sync posture) — so once the
    # delivery is RELEASED the daemon dies and no thread leaks. Deterministic via events, no sleeps.
    started = threading.Event()
    release = threading.Event()

    def deliver(batch: list[NeutralEvent]) -> None:
        started.set()  # signal the daemon is inside the delivery (mid-POST analog)
        assert release.wait(timeout=5.0), "the delivery was never released"

    # flush_at=1 ⇒ the daemon picks up the single event and enters the (blocking) delivery, leaving
    # the buffer empty; shutdown's drain finds nothing, so only the join races the short timeout.
    consumer = BatchConsumer(
        deliver, sync_mode=False, flush_at=1, flush_interval=1000.0, shutdown_timeout=0.1
    )
    try:
        consumer.enqueue(_event("in-flight"))
        assert started.wait(timeout=2.0), "the daemon never entered the in-flight delivery"

        elapsed = _time_shutdown(consumer)

        # Settled: shutdown returned bounded (near the 0.1s join timeout, not hung on the blocked
        # delivery) without raising, and quiesced the handle. The daemon is still blocked — orphaned
        # by design (daemon=True ⇒ it never blocks interpreter exit).
        assert consumer._stopped is True
        assert consumer._thread is None
        assert elapsed < 2.0, f"shutdown hung on the in-flight delivery ({elapsed:.2f}s)"
    finally:
        release.set()  # let the orphaned daemon finish its delivery and die — no leaked thread

    assert _await_no_consumer_thread(timeout=2.0), "the released daemon thread leaked"


def _time_shutdown(consumer: BatchConsumer) -> float:
    start = time.monotonic()
    consumer.shutdown()  # must not raise
    return time.monotonic() - start


def _await_no_consumer_thread(*, timeout: float) -> bool:
    """Poll (bounded) until no daemon named ``analytics-kit-consumer`` is alive — the released
    daemon dies once its in-flight delivery returns, which is asynchronous to shutdown()."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not any(t.name == "analytics-kit-consumer" for t in threading.enumerate()):
            return True
        time.sleep(0.01)
    return not any(t.name == "analytics-kit-consumer" for t in threading.enumerate())


def test_double_shutdown_is_idempotent() -> None:
    consumer = BatchConsumer(
        create_send_batch(_config(), _ScriptedTransport([200]), wait=_CountingWait()),
        flush_at=1000,
        flush_interval=1000.0,
    )
    consumer.shutdown()
    consumer.shutdown()  # a second shutdown is a no-op, never raises
    assert consumer._thread is None


def test_shutdown_leaves_no_live_consumer_thread() -> None:
    before = {t.name for t in threading.enumerate()}
    consumer = BatchConsumer(
        create_send_batch(_config(), _ScriptedTransport([200]), wait=_CountingWait()),
        flush_at=1000,
        flush_interval=1000.0,
    )
    consumer.enqueue(_event("e0"))
    consumer.shutdown()

    after = {t.name for t in threading.enumerate()}
    assert "analytics-kit-consumer" not in (after - before)


# --- unkeyed ⇒ whole-stack no-op (queue never built) -------------------------------------


def test_unkeyed_is_a_whole_stack_no_op() -> None:
    provider = create_server_analytics(AnalyticsConfig(ingest_host="https://ingest.example"))
    # No key ⇒ the NoopAdapter; capture/flush/shutdown are all inert and never touch a queue.
    provider.capture("u1", "signed_up", {"amount": 5})
    provider.flush()
    provider.shutdown()


# --- keyed-but-hostless is a misconfiguration that must WARN, not fail silently ------------


def test_keyed_without_ingest_host_warns(caplog: pytest.LogCaptureFixture) -> None:
    # A key set but no ingest_host: every batch POSTs to a host-less URL, fails, and is dropped.
    # Silently, before the fix — now it warns loudly at construction (TS-parity).
    with caplog.at_level("WARNING", logger="analytics_kit"):
        create_server_analytics(AnalyticsConfig(key="k", sync_mode=True))  # sync ⇒ no daemon thread
    assert any("no ingest_host is configured" in r.message for r in caplog.records)


def test_keyed_with_ingest_host_does_not_warn(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level("WARNING", logger="analytics_kit"):
        create_server_analytics(
            AnalyticsConfig(key="k", ingest_host="https://ingest.example", sync_mode=True)
        )
    assert not any("no ingest_host is configured" in r.message for r in caplog.records)


# --- config: the additive reliability knobs ----------------------------------------------


def test_reliability_config_defaults() -> None:
    config = AnalyticsConfig()
    assert config.shutdown_timeout == 30.0
    assert config.retry_count == 3
    assert config.retry_delay == 3.0


def test_reliability_config_overrides_parse() -> None:
    config = AnalyticsConfig(shutdown_timeout=5.0, retry_count=1, retry_delay=0.5)
    assert config.shutdown_timeout == 5.0
    assert config.retry_count == 1
    assert config.retry_delay == 0.5


def test_reliability_config_coexists_with_the_queue_and_endpoint_fields() -> None:
    config = AnalyticsConfig(
        key="k",
        ingest_host="https://ingest.example",
        flush_at=5,
        max_batch_size=50,
        shutdown_timeout=10.0,
        retry_count=2,
        retry_delay=1.0,
    )
    assert config.flush_at == 5
    assert config.max_batch_size == 50
    assert config.shutdown_timeout == 10.0
