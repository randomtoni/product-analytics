"""The definition poller — fetch flag DEFINITIONS (not evaluated flags) on an interval, parse them
into an in-memory :class:`DefinitionSnapshot` the evaluator reads.

The ONLY blocking-I/O boundary in local eval lives here (the definitions fetch); the matcher is a
pure synchronous function. Blocking round-trip behind a background thread, exactly the posture the
E12 remote flag adapter and the HTTP query adapter use — no asyncio.

Poll-thread hygiene (the E12-S4 daemon-thread-leak lesson): the loop is a ``threading.Event``-gated
daemon whose :meth:`stop` SETS the event and JOINS the thread, so no thread leaks past a test that
stops it. Concurrent :meth:`load` calls dedup onto a single in-flight lock so only one fetch runs at
a time. An injectable transport (the same :class:`~analytics_kit.flags.transport.FlagTransport` seam
the remote adapter uses) so tests never hit a live backend.
"""

# De-branded from posthog's poller.py (the definition poll loop), feature_flags.py
# _load_feature_flags / load_feature_flags / update_flag_state, and flag_definition_cache.py.

from __future__ import annotations

import json
import threading

from ..transport import FlagTransport, _UrllibFlagTransport
from .definition_types import (
    EMPTY_SNAPSHOT,
    DefinitionSnapshot,
    FlagDefinition,
    PropertyGroup,
)

# --- Wire definition-fetch vocabulary ------------------------------------------------------------
#
# The definitions endpoint path, its query params, the auth scheme, and the response keys — all
# adapter-internal, confined to these module-level ``_WIRE_*`` constants and never leaving this
# module. A future backend adapter negotiating a different definition wire supplies its own. The
# neutral config carries only ``definitions_endpoint``/``definitions_key``/``token``, never these.
# De-branded from posthog's node definitions request + response.
_WIRE_DEFINITIONS_PATH = "/flags/definitions"
_WIRE_TOKEN_QUERY = "token"
_WIRE_SEND_COHORTS_QUERY = "send_cohorts"
_WIRE_FLAGS_KEY = "flags"
_WIRE_GROUP_TYPE_MAPPING_KEY = "group_type_mapping"
_WIRE_COHORTS_KEY = "cohorts"

_WIRE_METHOD_GET = "GET"
_WIRE_CONTENT_TYPE_HEADER = "Content-Type"
_WIRE_CONTENT_TYPE_JSON = "application/json"
_WIRE_AUTHORIZATION_HEADER = "Authorization"
_WIRE_BEARER_SCHEME = "Bearer"

_STATUS_OK_FLOOR = 200
_STATUS_OK_CEIL = 300


class DefinitionPoller:
    """Poll flag definitions on an interval into an in-memory snapshot the evaluator reads.

    ``definitions_key`` is the privileged (definition-reading) credential, named BY ROLE — never a
    vendor key name; it authorizes the definition fetch and is distinct from the ingest write key and
    the remote-eval project key. ``token`` scopes the definitions to a project. The transport is the
    injectable HTTP send hook (default a stdlib ``urllib`` GET).
    """

    def __init__(
        self,
        *,
        definitions_endpoint: str,
        definitions_key: str,
        token: str,
        poll_interval: float,
        transport: FlagTransport | None = None,
    ) -> None:
        self._url = _resolve_definitions_url(definitions_endpoint, token)
        self._definitions_key = definitions_key
        self._poll_interval = poll_interval
        self._transport: FlagTransport = transport if transport is not None else _UrllibFlagTransport()
        self._snapshot: DefinitionSnapshot = EMPTY_SNAPSHOT
        self._loaded_successfully_once = False
        # In-flight dedup: only one fetch runs at a time; a concurrent load waits on this lock and
        # sees the just-loaded snapshot instead of issuing a second request.
        self._load_lock = threading.Lock()
        self._stopped = threading.Event()
        # Set once the daemon thread's FIRST load attempt has completed (success OR failure). The
        # deterministic "the fire-and-forget first load has drained" signal — the sync analog of
        # awaiting the TS async `start()`. Production never blocks on it (is_ready() gates eval);
        # only a test that needs the first load settled before asserting readiness waits on it.
        self._first_load_done = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        """Kick off polling and RETURN AT ONCE — the daemon thread does the first load as its own
        first step, so construction never blocks on the definitions round-trip (an unreachable
        endpoint must not hang app boot). ``is_ready()`` gates local eval, so ``evaluate`` falls
        through to remote/degraded until that first load lands. A background loop then reloads every
        ``poll_interval`` until :meth:`stop`. Idempotent — a second ``start`` is a no-op."""
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run, name="analytics-kit-flag-poller", daemon=True
        )
        self._thread.start()

    def is_ready(self) -> bool:
        """True once at least one successful load parsed a non-empty definition list — the "should I
        try local eval" gate."""
        return self._loaded_successfully_once and len(self._snapshot.flags) > 0

    def wait_for_first_load(self, timeout: float | None = None) -> bool:
        """Block until the daemon thread's FIRST load ATTEMPT has completed (success OR failure), then
        report whether the wait actually observed that completion (``False`` on timeout).

        The synchronous analog of awaiting the TS async ``start()``: since ``start()`` returns before
        the fire-and-forget first load runs, a caller that needs the load settled (a test asserting
        local eval, or the negative case) waits here. Completion is NOT the same as readiness — a
        failed first load completes but leaves :meth:`is_ready` ``False``; check ``is_ready()``
        separately after this returns (mirroring the TS ``await start(); expect(isReady())`` sequence).
        Never called on the production path (eval falls through to remote until the load lands)."""
        return self._first_load_done.wait(timeout)

    def get_snapshot(self) -> DefinitionSnapshot:
        """The current parsed definition snapshot, read atomically by the evaluator. Before the first
        successful load this is the frozen empty snapshot (never ``None``)."""
        return self._snapshot

    def stop(self) -> None:
        """Halt polling: SET the stop event and JOIN the poll thread so no thread leaks. Idempotent —
        this is the E12-S4 leak fix; every test that starts the poller calls it in teardown."""
        self._stopped.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=5)
        self._thread = None

    def load(self) -> None:
        """Load definitions once, deduping a concurrent call onto the same in-flight lock. A failed
        load leaves the prior snapshot in place — never overwrite good data with an error; the next
        scheduled poll retries."""
        with self._load_lock:
            self._fetch_definitions()

    def _run(self) -> None:
        # The first load runs HERE, on the thread — never on the caller's stack — so construction
        # returns before any network I/O. The reference daemon posture is a bare `threading.Thread`
        # with `daemon=True` and no clean stop (the E12-S4 leak source); here the loop is
        # `Event`-gated: `wait(interval)` returns True the instant `stop()` sets the event, so the
        # loop exits promptly and `stop()`'s join returns — no leaked thread.
        try:
            self.load()
        finally:
            # Signal completion in a `finally`, UNCONDITIONALLY — an unexpected raise in the first
            # load must still release a `wait_for_first_load` waiter (else it hangs to its timeout).
            self._first_load_done.set()
        while not self._stopped.wait(self._poll_interval):
            self.load()

    def _fetch_definitions(self) -> None:
        try:
            response = self._transport.send(
                self._url,
                _WIRE_METHOD_GET,
                {
                    _WIRE_CONTENT_TYPE_HEADER: _WIRE_CONTENT_TYPE_JSON,
                    _WIRE_AUTHORIZATION_HEADER: f"{_WIRE_BEARER_SCHEME} {self._definitions_key}",
                },
            )
        except Exception:  # noqa: BLE001 — a transport failure leaves the prior snapshot; the next poll retries.
            return
        if not _STATUS_OK_FLOOR <= response.status < _STATUS_OK_CEIL:
            return
        parsed = _parse_definitions(response.body)
        if parsed is None:
            return
        self._snapshot = parsed
        self._loaded_successfully_once = True


def _parse_definitions(body: str) -> DefinitionSnapshot | None:
    """Parse the wire definitions response into a :class:`DefinitionSnapshot`. ``None`` on a malformed
    body — the caller leaves the prior snapshot in place."""
    try:
        decoded = json.loads(body)
    except (ValueError, TypeError):
        return None
    if not isinstance(decoded, dict):
        return None
    raw_flags = decoded.get(_WIRE_FLAGS_KEY)
    flags: tuple[FlagDefinition, ...] = tuple(raw_flags) if isinstance(raw_flags, list) else ()
    flags_by_key = {str(flag.get("key")): flag for flag in flags if isinstance(flag, dict)}
    group_type_mapping = decoded.get(_WIRE_GROUP_TYPE_MAPPING_KEY)
    cohorts = decoded.get(_WIRE_COHORTS_KEY)
    return DefinitionSnapshot(
        flags=flags,
        flags_by_key=flags_by_key,
        group_type_mapping=dict(group_type_mapping) if isinstance(group_type_mapping, dict) else {},
        cohorts=_cohorts(cohorts),
    )


def _cohorts(raw: object) -> dict[str, PropertyGroup]:
    return {str(k): v for k, v in raw.items()} if isinstance(raw, dict) else {}


def _resolve_definitions_url(definitions_endpoint: str, token: str) -> str:
    """Resolve the definitions URL from the consumer's bare flag origin: append the definitions path
    and the token + send-cohorts query params."""
    host = definitions_endpoint.strip().rstrip("/")
    return f"{host}{_WIRE_DEFINITIONS_PATH}?{_WIRE_TOKEN_QUERY}={token}&{_WIRE_SEND_COHORTS_QUERY}="
