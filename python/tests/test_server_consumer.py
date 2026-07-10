"""Tests for the server batch queue + background daemon-thread consumer.

These pin the consumer contract: the size-OR-interval flush trigger, the load-bearing
drop-OLDEST overflow policy (the named test a drop-newest implementation must fail),
``max_batch_size`` slicing, the ``sync_mode`` inline bypass vs the daemon-thread posture, the
config-overridable defaults with their floors, the in-memory-only guarantee, and the minimal
``flush``/``shutdown`` lifecycle that keeps a daemon thread from leaking across the session.

Determinism-first: the size-trigger, drop-oldest, and slicing tests drive the drain step
directly or run in ``sync_mode``; only one small, bounded test exercises the live thread.
"""

from __future__ import annotations

import threading
import time

from analytics_kit import AnalyticsConfig, BatchConsumer, ServerAdapter, create_server_analytics
from analytics_kit.neutral_event import NeutralEvent
from analytics_kit.server.consumer import (
    DEFAULT_FLUSH_AT,
    DEFAULT_FLUSH_INTERVAL,
    DEFAULT_MAX_BATCH_SIZE,
    DEFAULT_MAX_QUEUE_SIZE,
)


def _event(tag: str) -> NeutralEvent:
    return NeutralEvent(event=tag, distinct_id="u1", dedupe_id=tag)


class _Recorder:
    """A delivery callback that records each batch and every event delivered, in order."""

    def __init__(self) -> None:
        self.batches: list[list[NeutralEvent]] = []

    def __call__(self, batch: list[NeutralEvent]) -> None:
        self.batches.append(batch)

    @property
    def delivered(self) -> list[NeutralEvent]:
        return [event for batch in self.batches for event in batch]


def _buffered_tags(consumer: BatchConsumer) -> list[str]:
    """Read the BUFFERED (not-yet-delivered) state directly — the honest read the drop-oldest
    test needs, since a flush would drain everything and mask which event was evicted."""
    return [event.event for event in consumer._buffer]


def _paused_consumer(*, max_queue_size: int) -> BatchConsumer:
    """An async consumer whose drain thread is stopped BEFORE any enqueue, so the buffer
    accumulates without draining — the "thread not draining" posture the drop-oldest test needs
    to observe overflow without a flush masking which event was evicted. ``flush_at`` is set to
    the cap so the size trigger can't inline-drain and the ``max_queue_size`` floor is a no-op.

    The drain thread is paused (stopped + joined) WITHOUT quiescing — unlike ``shutdown()``, which
    latches the consumer inert; here later enqueues must still buffer, so the test can observe the
    drop-oldest eviction on overflow."""
    consumer = BatchConsumer(sync_mode=False, flush_at=max_queue_size, max_queue_size=max_queue_size)
    thread = consumer._thread
    with consumer._lock:
        consumer._running = False
        consumer._not_empty.notify()
    if thread is not None:
        thread.join()
    consumer._thread = None
    return consumer


# --- locked defaults --------------------------------------------------------------------


def test_locked_defaults() -> None:
    assert DEFAULT_FLUSH_AT == 20
    assert DEFAULT_FLUSH_INTERVAL == 10.0
    assert DEFAULT_MAX_BATCH_SIZE == 100
    assert DEFAULT_MAX_QUEUE_SIZE == 1000


# --- size trigger (driven directly, no thread) ------------------------------------------


def test_size_trigger_flushes_at_flush_at_in_sync_mode() -> None:
    recorder = _Recorder()
    consumer = BatchConsumer(recorder, sync_mode=True, flush_at=3)

    consumer.enqueue(_event("e0"))
    consumer.enqueue(_event("e1"))
    assert recorder.delivered == []  # below the threshold: nothing delivered yet

    consumer.enqueue(_event("e2"))  # reaches flush_at=3 → inline delivery
    assert [e.event for e in recorder.delivered] == ["e0", "e1", "e2"]


def test_below_size_trigger_buffers_without_delivering() -> None:
    recorder = _Recorder()
    consumer = BatchConsumer(recorder, sync_mode=True, flush_at=5)

    for i in range(4):
        consumer.enqueue(_event(f"e{i}"))

    assert recorder.delivered == []
    assert _buffered_tags(consumer) == ["e0", "e1", "e2", "e3"]


# --- interval trigger (bounded wait, injected short interval) ----------------------------


def test_interval_trigger_flushes_a_partial_buffer() -> None:
    recorder = _Recorder()
    delivered = threading.Event()

    def deliver(batch: list[NeutralEvent]) -> None:
        recorder(batch)
        delivered.set()

    # flush_at high so the size trigger can't fire; a short interval drives the flush.
    consumer = BatchConsumer(deliver, flush_at=1000, flush_interval=0.05)
    try:
        consumer.enqueue(_event("e0"))
        assert delivered.wait(timeout=2.0), "interval trigger did not flush the partial buffer"
        assert [e.event for e in recorder.delivered] == ["e0"]
    finally:
        consumer.shutdown()


# --- ⚠ the named drop-OLDEST test (this story OWNS the pin) ------------------------------


def test_overflow_drops_the_oldest_event() -> None:
    # Small cap, consumer NOT draining (async thread stopped before enqueue): fill with
    # e0,e1,e2 then enqueue e3. The OLDEST (e0) must be evicted and the NEWEST (e3) present —
    # read from the BUFFER directly, not delivered events.
    #
    # A drop-newest implementation (a bounded queue that rejects the incoming event when full)
    # would keep e0 and drop e3, failing this exact assertion.
    consumer = _paused_consumer(max_queue_size=3)

    for tag in ("e0", "e1", "e2"):
        consumer.enqueue(_event(tag))
    assert _buffered_tags(consumer) == ["e0", "e1", "e2"]  # buffer full at the cap

    consumer.enqueue(_event("e3"))  # one past the cap

    buffered = _buffered_tags(consumer)
    assert "e0" not in buffered, "the OLDEST event must be evicted at cap (drop-oldest)"
    assert "e3" in buffered, "the NEWEST event must survive (a drop-newest impl fails here)"
    assert buffered == ["e1", "e2", "e3"]


def test_overflow_never_blocks_and_never_force_flushes() -> None:
    # Enqueuing well past the cap neither blocks nor delivers (no force-flush): the buffer just
    # slides, keeping only the newest cap. The drain thread is stopped, so no flush can mask it.
    consumer = _paused_consumer(max_queue_size=3)

    for i in range(10):
        consumer.enqueue(_event(f"e{i}"))

    assert _buffered_tags(consumer) == ["e7", "e8", "e9"]  # only the newest cap survive


# --- max_batch_size slicing (driven directly) -------------------------------------------


def test_flush_slices_into_max_batch_size_batches() -> None:
    recorder = _Recorder()
    # flush_at above the backlog so nothing auto-flushes; then force one drain.
    consumer = BatchConsumer(recorder, sync_mode=True, flush_at=1000, max_batch_size=2)

    for i in range(5):
        consumer.enqueue(_event(f"e{i}"))
    assert recorder.batches == []

    consumer.flush()

    assert [[e.event for e in batch] for batch in recorder.batches] == [
        ["e0", "e1"],
        ["e2", "e3"],
        ["e4"],
    ]


def test_next_batch_takes_at_most_max_batch_size_from_the_oldest_end() -> None:
    consumer = BatchConsumer(sync_mode=True, flush_at=1000, max_batch_size=2)
    for i in range(3):
        consumer.enqueue(_event(f"e{i}"))

    first = consumer._next_batch()
    second = consumer._next_batch()
    third = consumer._next_batch()

    assert [e.event for e in first] == ["e0", "e1"]
    assert [e.event for e in second] == ["e2"]
    assert third == []  # empty buffer → empty batch


# --- sync_mode bypass vs daemon-thread posture ------------------------------------------


def test_sync_mode_starts_no_thread() -> None:
    consumer = BatchConsumer(sync_mode=True)
    assert consumer._thread is None


def test_async_mode_starts_a_daemon_thread() -> None:
    consumer = BatchConsumer(sync_mode=False)
    try:
        thread = consumer._thread
        assert thread is not None
        assert thread.daemon is True
        assert thread.is_alive()
    finally:
        consumer.shutdown()


def test_daemon_thread_joins_on_shutdown_without_blocking() -> None:
    # The one focused live-thread test: a daemon thread that shutdown() joins within a bounded
    # window (never blocks exit). A blocking-forever loop would exceed the join timeout.
    consumer = BatchConsumer(sync_mode=False, flush_interval=0.05)
    thread = consumer._thread
    assert thread is not None and thread.is_alive()

    consumer.shutdown()

    thread.join(timeout=2.0)
    assert not thread.is_alive(), "shutdown must join the daemon thread (no leak)"
    assert consumer._thread is None


def test_async_consumer_delivers_via_the_thread() -> None:
    recorder = _Recorder()
    delivered = threading.Event()

    def deliver(batch: list[NeutralEvent]) -> None:
        recorder(batch)
        delivered.set()

    consumer = BatchConsumer(deliver, sync_mode=False, flush_at=2, flush_interval=5.0)
    try:
        consumer.enqueue(_event("e0"))
        consumer.enqueue(_event("e1"))  # reaches flush_at=2 → the thread drains
        assert delivered.wait(timeout=2.0), "the daemon thread did not deliver on the size trigger"
        assert {e.event for e in recorder.delivered} == {"e0", "e1"}
    finally:
        consumer.shutdown()


# --- floors: a misconfigured cap/threshold can't wedge the queue ------------------------


def test_max_queue_size_floors_at_flush_at() -> None:
    # A cap below the flush threshold would drop-oldest before the size trigger could ever
    # fire; the floor clamps max_queue_size up to flush_at.
    consumer = BatchConsumer(flush_at=20, max_queue_size=5, sync_mode=True)
    assert consumer._max_queue_size == 20
    assert consumer._buffer.maxlen == 20


def test_flush_at_and_max_batch_size_floor_at_one() -> None:
    consumer = BatchConsumer(flush_at=0, max_batch_size=0, sync_mode=True)
    assert consumer._flush_at == 1
    assert consumer._max_batch_size == 1


# --- config-overridable defaults --------------------------------------------------------


def test_config_carries_the_locked_defaults() -> None:
    config = AnalyticsConfig()
    assert config.flush_at == 20
    assert config.flush_interval == 10.0
    assert config.max_batch_size == 100
    assert config.max_queue_size == 1000


def test_config_overrides_all_four_defaults() -> None:
    config = AnalyticsConfig(
        flush_at=5,
        flush_interval=0.5,
        max_batch_size=25,
        max_queue_size=250,
    )
    assert config.flush_at == 5
    assert config.flush_interval == 0.5
    assert config.max_batch_size == 25
    assert config.max_queue_size == 250


def test_config_queue_knobs_reach_the_consumer_via_the_target_entry() -> None:
    provider = create_server_analytics(
        AnalyticsConfig(
            key="k1",
            sync_mode=True,
            flush_at=3,
            max_batch_size=7,
            max_queue_size=9,
        )
    )
    adapter = provider._adapter
    assert isinstance(adapter, ServerAdapter)
    consumer = adapter._sink
    assert isinstance(consumer, BatchConsumer)
    assert consumer._flush_at == 3
    assert consumer._max_batch_size == 7
    assert consumer._max_queue_size == 9


# --- in-memory only (no persistence) ----------------------------------------------------


def test_buffer_is_in_memory_only() -> None:
    from collections import deque

    consumer = BatchConsumer(sync_mode=True)
    assert isinstance(consumer._buffer, deque)


# --- minimal flush / shutdown lifecycle -------------------------------------------------


def test_flush_force_drains_the_buffer_once() -> None:
    recorder = _Recorder()
    consumer = BatchConsumer(recorder, sync_mode=True, flush_at=1000)
    for i in range(3):
        consumer.enqueue(_event(f"e{i}"))
    assert recorder.delivered == []

    consumer.flush()

    assert [e.event for e in recorder.delivered] == ["e0", "e1", "e2"]
    assert _buffered_tags(consumer) == []


def test_shutdown_final_drains_remaining_events() -> None:
    recorder = _Recorder()
    consumer = BatchConsumer(recorder, sync_mode=False, flush_at=1000, flush_interval=5.0)
    consumer.enqueue(_event("e0"))

    consumer.shutdown()

    assert [e.event for e in recorder.delivered] == ["e0"]


def test_shutdown_is_idempotent_on_a_sync_consumer() -> None:
    # A sync consumer has no thread; shutdown drains and does not raise on a second call.
    consumer = BatchConsumer(sync_mode=True)
    consumer.shutdown()
    consumer.shutdown()


# --- adapter lifecycle drives the injected consumer -------------------------------------


def test_adapter_flush_drives_the_consumer_drain() -> None:
    recorder = _Recorder()
    consumer = BatchConsumer(recorder, sync_mode=True, flush_at=1000)
    adapter = ServerAdapter(version="0.0.0", sink=consumer)
    for i in range(2):
        adapter.capture(_event(f"e{i}"))
    assert recorder.delivered == []

    adapter.flush()

    assert [e.event for e in recorder.delivered] == ["e0", "e1"]


def test_adapter_shutdown_joins_the_consumer_thread() -> None:
    consumer = BatchConsumer(sync_mode=False, flush_interval=0.05)
    adapter = ServerAdapter(version="0.0.0", sink=consumer)
    thread = consumer._thread
    assert thread is not None and thread.is_alive()

    adapter.shutdown()

    thread.join(timeout=2.0)
    assert not thread.is_alive()


def test_adapter_lifecycle_is_inert_for_a_plain_callable_sink() -> None:
    # A plain-callable sink (the default in-memory buffer needs no drain) has no flush/shutdown;
    # the adapter's lifecycle verbs must be inert, not raise.
    captured: list[NeutralEvent] = []
    adapter = ServerAdapter(version="0.0.0", sink=captured.append)
    adapter.capture(_event("e0"))

    adapter.flush()
    adapter.shutdown()

    assert [e.event for e in captured] == ["e0"]


# --- no leaked daemon threads across the session ----------------------------------------


def test_no_consumer_threads_leak_after_shutdown() -> None:
    before = {t.name for t in threading.enumerate()}
    consumer = BatchConsumer(sync_mode=False, flush_interval=0.05)
    assert "analytics-kit-consumer" in {t.name for t in threading.enumerate()}

    consumer.shutdown()
    time.sleep(0.05)

    after = {t.name for t in threading.enumerate()}
    assert "analytics-kit-consumer" not in (after - before)
