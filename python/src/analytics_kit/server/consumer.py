"""The server batch queue + background daemon-thread consumer.

A server process can't POST one request per event: captured events accumulate in a bounded
in-memory buffer and are delivered in batches on the EARLIER of a size trigger (``flush_at``
buffered) OR an interval trigger (``flush_interval`` seconds elapsed). The consumer is a
plain callable :class:`BatchConsumer` the adapter routes ``capture`` to (an ``EventSink``);
it owns WHEN and HOW MUCH to flush and hands each sliced batch to an injected delivery
callback that owns the actual send — so the real wire delivery slots in behind the same
callback with no reshaping here.

Two delivery postures share one buffer and one drain path:

* ``sync_mode=True`` — no thread; each enqueue delivers inline on the calling thread once the
  size trigger is reached (the posture short-lived scripts and tests use).
* ``sync_mode=False`` (default) — a ``daemon`` background thread drains the buffer with a
  block-with-timeout loop, so it never blocks process exit and is joined at exit.

**Overflow is drop-OLDEST at ``max_queue_size``**: at cap the OLDEST buffered event is evicted
before the newest is enqueued (a bounded :class:`collections.deque`, whose ``append``
auto-evicts the oldest end at ``maxlen``). It never blocks and never force-flushes. This
matches the cross-target buffer contract; the drop-NEWEST idiom (a bounded queue that rejects
the incoming event when full) is deliberately NOT used.
"""

from __future__ import annotations

import atexit
import threading
import time
from collections import deque
from collections.abc import Callable

from ..neutral_event import NeutralEvent

DEFAULT_FLUSH_AT = 20
DEFAULT_FLUSH_INTERVAL = 10.0
DEFAULT_MAX_BATCH_SIZE = 100
DEFAULT_MAX_QUEUE_SIZE = 1000

DeliverBatch = Callable[[list[NeutralEvent]], None]
"""The delivery seam: the consumer hands each ``max_batch_size``-sliced batch to this callable,
which owns the actual send. A backlog larger than ``max_batch_size`` produces multiple calls in
one drain. The real wire delivery replaces the stub behind this same signature."""


class _RecordingDelivery:
    """The default delivery target — records batches without a network. Replaced by the real
    transport, injected by construction."""

    def __init__(self) -> None:
        self.batches: list[list[NeutralEvent]] = []

    def __call__(self, batch: list[NeutralEvent]) -> None:
        self.batches.append(batch)


class BatchConsumer:
    """A bounded batch buffer drained on a size-or-interval trigger.

    The adapter routes ``capture`` to this instance (it is an ``EventSink``): each call
    enqueues an already-minted :class:`~analytics_kit.NeutralEvent`. In async mode a daemon
    thread drains the buffer; in ``sync_mode`` each enqueue delivers inline once the size
    trigger fires. The buffer is drop-OLDEST at ``max_queue_size``.
    """

    def __init__(
        self,
        deliver: DeliverBatch | None = None,
        *,
        sync_mode: bool = False,
        flush_at: int = DEFAULT_FLUSH_AT,
        flush_interval: float = DEFAULT_FLUSH_INTERVAL,
        max_batch_size: int = DEFAULT_MAX_BATCH_SIZE,
        max_queue_size: int = DEFAULT_MAX_QUEUE_SIZE,
    ) -> None:
        self._deliver: DeliverBatch = deliver if deliver is not None else _RecordingDelivery()
        # Floor flush_at and max_batch_size at 1: a misconfigured 0 would either wedge the
        # size trigger (never reachable) or slice into empty batches.
        self._flush_at = max(flush_at, 1)
        self._flush_interval = flush_interval
        self._max_batch_size = max(max_batch_size, 1)
        # Floor max_queue_size at flush_at: a cap below the flush threshold would drop-oldest
        # before the size trigger could ever fire, wedging into a never-size-flush state.
        self._max_queue_size = max(max_queue_size, self._flush_at)

        self._sync_mode = sync_mode
        self._lock = threading.Lock()
        self._buffer: deque[NeutralEvent] = deque(maxlen=self._max_queue_size)
        self._not_empty = threading.Condition(self._lock)

        self._running = False
        self._thread: threading.Thread | None = None
        if not sync_mode:
            self._start()

    def __call__(self, event: NeutralEvent) -> None:
        """Enqueue an already-minted event — the ``EventSink`` the adapter routes ``capture`` to."""
        self.enqueue(event)

    def enqueue(self, event: NeutralEvent) -> None:
        """Buffer an event; at cap the OLDEST buffered event is dropped (never blocks).

        In ``sync_mode`` a full buffer (size trigger reached) delivers inline before returning.
        """
        with self._lock:
            # deque(maxlen=...) auto-evicts from the OLDEST (left) end on append at cap — the
            # drop-OLDEST overflow policy. A bounded queue that rejected the incoming event
            # would drop the NEWEST, the wrong policy here.
            self._buffer.append(event)
            self._not_empty.notify()
            reached_size_trigger = len(self._buffer) >= self._flush_at

        if self._sync_mode and reached_size_trigger:
            self._drain_all()

    def _next_batch(self) -> list[NeutralEvent]:
        """Take up to ``max_batch_size`` events off the OLDEST end of the buffer.

        Returns an empty list when the buffer is empty. The directly-callable drain step the
        deterministic tests drive (no thread, no wall-clock wait).
        """
        with self._lock:
            batch: list[NeutralEvent] = []
            while self._buffer and len(batch) < self._max_batch_size:
                batch.append(self._buffer.popleft())
            return batch

    def _drain_all(self) -> None:
        """Drain the whole buffer, delivering it in ``max_batch_size``-sliced batches."""
        while True:
            batch = self._next_batch()
            if not batch:
                return
            self._deliver(batch)

    def _run(self) -> None:
        """The daemon-thread loop: deliver on the size OR interval trigger, exit when stopped.

        The interval deadline is anchored to the FIRST event since the buffer last emptied, so
        a steady sub-threshold trickle still flushes on the interval — a notify only shortens
        the wait, it never resets the deadline (the single-armed-interval contract).
        """
        deadline: float | None = None
        while True:
            with self._lock:
                if not self._running and not self._buffer:
                    return
                buffered = len(self._buffer)
                if buffered == 0:
                    deadline = None
                    self._not_empty.wait(timeout=self._flush_interval)
                    continue
                if buffered < self._flush_at:
                    if deadline is None:
                        deadline = time.monotonic() + self._flush_interval
                    remaining = deadline - time.monotonic()
                    if remaining > 0 and self._running:
                        self._not_empty.wait(timeout=remaining)
                        continue
            deadline = None
            self._drain_all()

    def _start(self) -> None:
        self._running = True
        thread = threading.Thread(target=self._run, name="analytics-kit-consumer", daemon=True)
        self._thread = thread
        thread.start()
        atexit.register(self.shutdown)

    def flush(self) -> None:
        """Force-drain the buffer once, blocking until every triggered delivery returns.

        Minimal by design — the hardened, timeout-raced drain lands with the reliability slice.
        """
        self._drain_all()

    def shutdown(self) -> None:
        """Signal the consumer to stop, wake and join the daemon thread, then final-drain.

        Minimal by design (the hardened quiesce/timeout lands with the reliability slice), but
        enough that a live daemon thread is never leaked past process exit.
        """
        thread = self._thread
        if thread is not None:
            with self._lock:
                self._running = False
                self._not_empty.notify()
            thread.join()
            self._thread = None
        self._drain_all()
