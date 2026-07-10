"""The server remote-eval feature-flag adapter — the Python analog of the TS-node flag client.

Satisfies the frozen S1 :class:`~analytics_kit.FeatureFlagPort` with a server-shaped
implementation: no persistence, no init-time fetch, no cache shared across actors. Each
``evaluate`` is an independent per-call blocking round-trip for its OWN ``distinct_id`` (a
stateless server has no ambient actor), so a wire body is NEVER shared across calls with
differing contexts. ``distinct_id`` is required and validated (a clear NEUTRAL error thrown
BEFORE any network); ``on_change`` fires ONCE with the resolved set on the first ``evaluate``
(the stateless-server degenerate cardinality), then never again.

``evaluate`` is SYNCHRONOUS by design — a bare :class:`~analytics_kit.FlagSet`, never a
coroutine. The blocking round-trip lives inside this adapter, mirroring how the HTTP query
adapter hides its POST/poll behind blocking I/O (the locked no-asyncio server posture). A
non-2xx or network failure does NOT raise out of ``evaluate``: it degrades to the bootstrap
seed (marked ``stale``) when one is configured, else the canonical ``empty_flag_set()``
(``unresolved``) — the neutral degradation signal. Flags degrade; they do not retry like
capture.

Every wire concern — the endpoint path, the request-body keys, and the response keys this
backend's flag-decision endpoint speaks — is sealed in the ``_WIRE_*`` constants below and never
leaves this module. The exported surface carries the neutral :class:`FlagContext`/:class:`FlagSet`
vocabulary only; no dialect vocabulary escapes, and no vendor eval-quality field (errors-while-
computing / quota-limited / request-id / per-flag reason) is read onto the snapshot.
"""

from __future__ import annotations

import json
from collections.abc import Callable

from ..ports import (
    FeatureFlagPort,
    FlagContext,
    FlagEvaluateOptions,
    FlagReason,
    FlagSet,
    FlagValue,
    empty_flag_set,
)
from .local import (
    DefinitionPoller,
    FlagDefinition,
    InconclusiveMatchError,
    RequiresServerEvaluation,
    compute_flag_locally,
)
from .transport import FlagTransport, _UrllibFlagTransport

# --- Wire endpoint path -----------------------------------------------------------------
#
# The flag-eval decision path appended to the config-supplied flag-endpoint origin. Wire-shaped,
# adapter-internal — the neutral config carries only ``flag_endpoint``, never this template. A
# different backend points at its own origin with its own path. De-branded from posthog's node
# flags decision endpoint.
_WIRE_FLAG_PATH = "/flags/?v=2"

# --- Wire request-body keys -------------------------------------------------------------
#
# The keys the flag endpoint reads. Plain (non-``$``) wire tokens; the adapter maps the neutral
# FlagContext onto them. ``_WIRE_API_KEY`` authenticates the request in-body (a backend-specific
# convention, mirroring the node capture transport's in-body auth — never an Authorization header).
# De-branded from posthog's node evaluateFlags request body.
_WIRE_API_KEY = "api_key"
_WIRE_DISTINCT_ID_KEY = "distinct_id"
_WIRE_GROUPS_KEY = "groups"
_WIRE_PERSON_PROPERTIES_KEY = "person_properties"
_WIRE_GROUP_PROPERTIES_KEY = "group_properties"
_WIRE_FLAG_KEYS_KEY = "flag_keys_to_evaluate"

# --- Wire response keys -----------------------------------------------------------------
#
# The response envelope carries the resolved set under ``_WIRE_FLAGS_KEY`` — a per-flag object map.
# Each per-flag object exposes the flag VALUE (``_WIRE_ENABLED_KEY`` bool + ``_WIRE_VARIANT_KEY``
# variant) and its payload (``_WIRE_METADATA_KEY``.``_WIRE_PAYLOAD_KEY``, a JSON string). Eval-
# quality metadata the endpoint may also return (errors-while-computing, quota-limited, request-id,
# per-flag reason) is DELIBERATELY not read — only the neutral degraded/reason signal reaches the
# FlagSet. De-branded from posthog's node v2 flags response.
_WIRE_FLAGS_KEY = "flags"
_WIRE_ENABLED_KEY = "enabled"
_WIRE_VARIANT_KEY = "variant"
_WIRE_METADATA_KEY = "metadata"
_WIRE_PAYLOAD_KEY = "payload"

_WIRE_CONTENT_TYPE_HEADER = "Content-Type"
_WIRE_CONTENT_TYPE_JSON = "application/json"
_WIRE_METHOD_POST = "POST"

_STATUS_OK_FLOOR = 200
_STATUS_OK_CEIL = 300

# The consumer-observable reasons, mapped from the round-trip states onto the S1-pinned FlagReason
# union. Named here for the adapter's own use — never widened.
_REASON_RESOLVED: FlagReason = "resolved"
_REASON_BOOTSTRAP: FlagReason = "bootstrap"
_REASON_STALE: FlagReason = "stale"
_REASON_UNRESOLVED: FlagReason = "unresolved"


class _Snapshot:
    """The immutable resolved backing for one :class:`FlagSet`, plus the reason every read reports.

    Wrapped by a :class:`FlagSet` on each ``evaluate``. ``reason`` is uniform across a snapshot's
    keys — the snapshot-level state (freshly resolved, bootstrap seed/fallback, or degraded).
    ``is_enabled`` collapses a missing flag to ``False``; ``get_flag``/``get_payload`` distinguish
    missing (``None``) from disabled (``False``) — the neutralized server snapshot read contract.
    """

    __slots__ = ("_flags", "_payloads", "_reason", "_degraded")

    def __init__(
        self,
        flags: dict[str, FlagValue],
        payloads: dict[str, object],
        reason: FlagReason,
        degraded: bool,
    ) -> None:
        self._flags = flags
        self._payloads = payloads
        self._reason = reason
        self._degraded = degraded

    def is_enabled(self, key: str) -> bool:
        value = self._flags.get(key)
        return value is not None and value is not False

    def get_flag(self, key: str) -> FlagValue | None:
        return self._flags.get(key)

    def get_payload(self, key: str) -> object:
        return self._payloads.get(key)

    def get_all(self) -> dict[str, FlagValue]:
        return dict(self._flags)

    @property
    def payloads(self) -> dict[str, object]:
        return self._payloads

    @property
    def degraded(self) -> bool:
        return self._degraded

    def reason(self, key: str) -> FlagReason | None:
        if key in self._flags or key in self._payloads:
            return self._reason
        return None


def _is_ok(status: int) -> bool:
    return _STATUS_OK_FLOOR <= status < _STATUS_OK_CEIL


def _resolve_value(entry: dict[str, object]) -> FlagValue | None:
    """The resolved value rule: a variant string when present, else the ``enabled`` boolean.

    A disabled flag with no variant is ``False``; a well-formed entry with neither is dropped
    (``None``) so it does not appear as a spurious ``False`` in the resolved map.
    """
    variant = entry.get(_WIRE_VARIANT_KEY)
    if isinstance(variant, str):
        return variant
    enabled = entry.get(_WIRE_ENABLED_KEY)
    if isinstance(enabled, bool):
        return enabled
    return None


def _resolve_payload(entry: dict[str, object]) -> object:
    """The per-flag payload, parsed from its wire metadata. Arrives JSON-string-encoded; a
    parse failure falls back to the raw string rather than raising."""
    metadata = entry.get(_WIRE_METADATA_KEY)
    if not isinstance(metadata, dict):
        return None
    raw = metadata.get(_WIRE_PAYLOAD_KEY)
    if isinstance(raw, str) and raw:
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return raw
    return raw


def _parse_response(body: str) -> tuple[dict[str, FlagValue], dict[str, object]] | None:
    """Parse the wire response into resolved flags + payloads. ``None`` on a malformed body or a
    missing/ill-typed ``flags`` map — the caller maps that onto the neutral degradation."""
    try:
        decoded = json.loads(body)
    except (ValueError, TypeError):
        return None
    if not isinstance(decoded, dict):
        return None
    raw_flags = decoded.get(_WIRE_FLAGS_KEY)
    if not isinstance(raw_flags, dict):
        return None
    flags: dict[str, FlagValue] = {}
    payloads: dict[str, object] = {}
    for key, entry in raw_flags.items():
        if not isinstance(entry, dict):
            continue
        value = _resolve_value(entry)
        if value is not None:
            flags[key] = value
        payload = _resolve_payload(entry)
        if payload is not None:
            payloads[key] = payload
    return flags, payloads


def _seed_bootstrap(bootstrap: object) -> _Snapshot | None:
    """Seed a snapshot from config bootstrap — a resolved-shaped fallback served (as ``stale``)
    when a round-trip fails. ``None`` when no bootstrap is supplied. Accepts the neutral
    :class:`~analytics_kit.FlagBootstrap` model (duck-typed on its ``flags``/``payloads``)."""
    if bootstrap is None:
        return None
    flags = getattr(bootstrap, "flags", None) or {}
    payloads = getattr(bootstrap, "payloads", None) or {}
    return _Snapshot(dict(flags), dict(payloads), _REASON_BOOTSTRAP, degraded=False)


def _remote_uniform_reason(
    remote: FlagSet,
    remote_flags: dict[str, FlagValue],
    remote_payloads: dict[str, object],
) -> FlagReason:
    """Read the snapshot-uniform reason off a round-trip result for the merge. The remote is a
    ``_Snapshot`` (``reason`` uniform across its present keys) or the canonical ``empty_flag_set()``
    (every read ``unresolved``). Reading through any present key gives the uniform reason; a keyless
    remote (a failed round-trip with no bootstrap) is ``unresolved`` — the neutral degraded state."""
    for key in (*remote_flags, *remote_payloads):
        reason = remote.reason(key)
        if reason is not None:
            return reason
    return _REASON_UNRESOLVED


def _resolve_local_payload(definition: FlagDefinition, value: FlagValue) -> object:
    """The payload for a locally-resolved flag, keyed by the stringified resolved value on the
    definition's payload map — the local analog of the remote path's per-flag payload, so a
    locally-resolved flag carries its payload identically. A ``False`` (or absent) result carries no
    payload; a string payload is JSON-parsed (raw string on failure) so the local shape matches what a
    remote response delivers. Returns ``None`` when there is no payload (omit-not-null: the read
    surface reports a missing key as ``None`` uniformly across strategies)."""
    if value is False:
        return None
    payloads = _as_dict(_as_dict(definition.get("filters")).get("payloads"))
    # The payload map keys the resolved value as the wire lowercases it: a boolean True is the string
    # "true" (NOT Python's "True"), a variant is its key. Matches the JS `String(value)` convention so
    # a locally-resolved payload keys identically to a remote one.
    payload_key = "true" if value is True else str(value)
    raw = payloads.get(payload_key)
    if raw is None:
        return None
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return raw
    return raw


def _as_dict(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


class LocalEvalCapability:
    """The adapter's local-evaluation capability, supplied by the factory ONLY when the config
    selected a local-capable adapter (a definitions endpoint + privileged credential).

    Absent ⇒ remote-only, exactly as E12 shipped. ``poller`` owns the only blocking-I/O boundary (the
    definition fetch, behind a background thread). ``only_locally`` is the resolved effective
    ``only_evaluate_locally or strict_local_evaluation or False`` — when ``True`` the remote fallback
    is suppressed and an inconclusive flag resolves to its degraded neutral state.
    """

    __slots__ = ("poller", "only_locally")

    def __init__(self, poller: DefinitionPoller, only_locally: bool) -> None:
        self.poller = poller
        self.only_locally = only_locally


class HttpFlagAdapter:
    """The server flag adapter satisfying :class:`~analytics_kit.FeatureFlagPort`.

    Constructed by :func:`~analytics_kit.flags.factory.create_flag_client` when a key and a flag
    endpoint are configured (remote-only), OR when a definitions endpoint + privileged credential are
    configured (local-capable). Each remote ``evaluate`` is one independent blocking round-trip for
    its context's actor; nothing is shared across calls. When local-capable, ``evaluate`` runs a
    local-first strategy branch behind the SAME synchronous signature, falling back to the shipped
    remote round-trip for flags it can't resolve in-process — indistinguishable to the consumer.
    """

    def __init__(
        self,
        *,
        key: str,
        flag_endpoint: str | None = None,
        bootstrap: object = None,
        transport: FlagTransport | None = None,
        local: LocalEvalCapability | None = None,
    ) -> None:
        self._api_key = key
        self._url = (
            f"{flag_endpoint.rstrip('/')}{_WIRE_FLAG_PATH}"
            if flag_endpoint is not None and flag_endpoint.strip() != ""
            else None
        )
        self._bootstrap = _seed_bootstrap(bootstrap)
        self._transport: FlagTransport = transport if transport is not None else _UrllibFlagTransport()
        self._local = local
        self._listeners: set[Callable[[FlagSet], None]] = set()
        self._fired = False
        self._first_set: FlagSet | None = None
        # Start the definition poll (an immediate first load + a background loop) so local eval is
        # ready as soon as definitions land; until then evaluate falls through to remote (or the
        # degraded set under local-only). The poller owns the only I/O boundary.
        if self._local is not None:
            self._local.poller.start()

    def evaluate(
        self,
        context: FlagContext | None = None,
        options: FlagEvaluateOptions | None = None,
    ) -> FlagSet:
        """Resolve the flag snapshot for ``context``. Synchronous by design (a bare :class:`FlagSet`,
        never a coroutine) — a future reader must NOT "fix" this toward asyncio.

        The per-call ``distinct_id`` is the ONLY eval-identity source on the server — no persisted
        or ambient actor. Its absence is a caller error, not a degraded eval: a clear NEUTRAL
        error is raised BEFORE any network, and no listener fires. When local-capable, the strategy
        branch runs behind this same signature; otherwise it is the pure remote round-trip E12
        shipped.
        """
        distinct_id = context.get("distinct_id") if context is not None else None
        if not distinct_id:
            raise ValueError("analytics-kit: distinct_id is required to evaluate flags on the server")
        snapshot = self._resolve(context if context is not None else {})
        self._fire_once(snapshot)
        return snapshot

    def stop(self) -> None:
        """Halt the definition poller so no further loads are scheduled and no thread leaks (no-op
        when remote-only). Idempotent — the poll thread is the only leakable resource the adapter
        owns."""
        if self._local is not None:
            self._local.poller.stop()

    def _resolve(self, context: FlagContext) -> FlagSet:
        """Resolve a snapshot via the local-first strategy branch when local-capable and the poller
        is ready; otherwise the pure remote path E12 shipped. This is the ONLY place the strategy is
        decided — the returned :class:`FlagSet` is indistinguishable across strategies (same snapshot
        shape, same neutral ``reason``/``degraded``)."""
        local = self._local
        if local is None or not local.poller.is_ready():
            # Not local-capable, or definitions haven't loaded yet. Under local-only there is no
            # remote path — resolve to the neutral degraded-empty snapshot; otherwise the shipped
            # remote path with the ORIGINAL untouched context.
            if local is not None and local.only_locally:
                return _Snapshot({}, {}, _REASON_UNRESOLVED, degraded=True)
            return self._round_trip(context)
        return self._resolve_local_first(context, local)

    def _resolve_local_first(self, context: FlagContext, local: LocalEvalCapability) -> _Snapshot:
        """The local-first strategy: evaluate each requested flag in-process, collect the ones that
        can't be decided locally, and (unless local-only) layer ONE remote round-trip over just those
        keys. The merge is per-flag on the maps, snapshot-uniform on the reason — locally-resolved
        keys are kept, remote values fill only the still-unresolved ones. A partial failure degrades
        the whole snapshot, so a fallback flag that couldn't resolve reads like a remote failure."""
        snapshot = local.poller.get_snapshot()
        flag_keys = context.get("flag_keys")
        if flag_keys is not None:
            definitions = [snapshot.flags_by_key[k] for k in flag_keys if k in snapshot.flags_by_key]
        else:
            definitions = list(snapshot.flags)

        flags: dict[str, FlagValue] = {}
        payloads: dict[str, object] = {}
        fallback_keys: list[str] = []

        for definition in definitions:
            key = str(definition.get("key"))
            try:
                value = compute_flag_locally(definition, context, snapshot)
            except (InconclusiveMatchError, RequiresServerEvaluation):
                fallback_keys.append(key)
                continue
            flags[key] = value
            payload = _resolve_local_payload(definition, value)
            if payload is not None:
                payloads[key] = payload

        if not fallback_keys:
            return _Snapshot(flags, payloads, _REASON_RESOLVED, degraded=False)
        if local.only_locally:
            # Local-only suppresses the fallback: the inconclusive keys stay absent, and the snapshot
            # degrades because a requested flag could not be resolved.
            return _Snapshot(flags, payloads, _REASON_UNRESOLVED, degraded=True)
        # Fall back to the SHIPPED remote path for just the unresolved keys — one round-trip,
        # narrowed to the fallback set so the wire body only asks for what local eval couldn't decide.
        # Adopt the remote's snapshot-uniform reason/degraded (degraded-WINS on mixed, incl 'stale'):
        # a clean local flag reads the round-trip's reason, so a partial failure is one coherent state.
        remote = self._round_trip({**context, "flag_keys": fallback_keys})
        remote_flags = remote.get_all()
        remote_payloads = remote.payloads if hasattr(remote, "payloads") else {}
        return _Snapshot(
            {**flags, **remote_flags},
            {**payloads, **remote_payloads},
            _remote_uniform_reason(remote, remote_flags, remote_payloads),
            degraded=remote.degraded,
        )

    def on_change(self, listener: Callable[[FlagSet], None]) -> Callable[[], None]:
        """Register a snapshot listener; returns an unsubscribe callable.

        A stateless server fires once, on the first resolved set. A listener registered AFTER that
        fire receives the resolved set immediately (it missed the single fire); one registered
        before is fired when the first ``evaluate`` settles. Either way each listener sees the set
        exactly once — the degenerate cardinality of the browser's re-firing signature.
        """
        if self._fired and self._first_set is not None:
            listener(self._first_set)
            return lambda: None
        self._listeners.add(listener)

        def _unsubscribe() -> None:
            self._listeners.discard(listener)

        return _unsubscribe

    def _fire_once(self, snapshot: FlagSet) -> None:
        """Fire every registered listener exactly once, on the first resolved snapshot. Subsequent
        ``evaluate`` calls (different actors, fresh round-trips) do NOT re-fire — the server
        contract."""
        if self._fired:
            return
        self._fired = True
        self._first_set = snapshot
        for listener in list(self._listeners):
            listener(snapshot)
        self._listeners.clear()

    def _round_trip(self, context: FlagContext) -> FlagSet:
        """One independent round-trip for THIS context's actor. Success ⇒ a freshly resolved
        snapshot; a failed round-trip degrades to the bootstrap seed (``stale``) when one is
        configured, else the canonical ``empty_flag_set()`` (``unresolved``) — the neutral
        degradation signal. Vendor eval-quality fields on the response are never read.

        No remote endpoint configured (a local-only posture) ⇒ the remote path has nowhere to go;
        degrade to the neutral empty/seed snapshot rather than fetch. Reached only defensively — the
        strategy branch never routes to the remote path under local-only."""
        resolved = self._fetch(self._url, context) if self._url is not None else None
        if resolved is not None:
            flags, payloads = resolved
            return _Snapshot(flags, payloads, _REASON_RESOLVED, degraded=False)
        if self._bootstrap is not None:
            # Re-tag the already-seeded bootstrap snapshot as a degraded 'stale' fallback, reusing
            # its own flag AND payload maps — NOT re-derived from get_all() (flag keys only), which
            # would drop a payload-only bootstrap key that has no matching flag value.
            return _Snapshot(
                self._bootstrap.get_all(),
                dict(self._bootstrap.payloads),
                _REASON_STALE,
                degraded=True,
            )
        return empty_flag_set()

    def _fetch(
        self, url: str, context: FlagContext
    ) -> tuple[dict[str, FlagValue], dict[str, object]] | None:
        """POST the wire flag-eval body and parse the response. ``None`` on a non-OK status, a
        network failure, or a malformed body — the caller maps that onto the neutral degradation.
        The body carries THIS call's context; nothing is shared with any other call.

        A raised transport error is normalized to degradation here (flags degrade, they do not
        raise to the consumer): the stdlib default never raises — it catches ``HTTPError`` /
        network errors and returns the real status — but a custom injected transport might, and a
        flag failure must not crash ``evaluate``."""
        body = json.dumps(self._build_wire_body(context))
        try:
            response = self._transport.send(
                url,
                _WIRE_METHOD_POST,
                {_WIRE_CONTENT_TYPE_HEADER: _WIRE_CONTENT_TYPE_JSON},
                body,
            )
        except Exception:  # noqa: BLE001 — normalize any transport failure to degradation.
            return None
        if not _is_ok(response.status):
            return None
        return _parse_response(response.body)

    def _build_wire_body(self, context: FlagContext) -> dict[str, object]:
        """Map the neutral FlagContext onto the adapter-internal wire request body for THIS actor.
        ``distinct_id`` is guaranteed present (validated in ``evaluate``); the rest ride only when
        supplied."""
        body: dict[str, object] = {
            _WIRE_API_KEY: self._api_key,
            _WIRE_DISTINCT_ID_KEY: context["distinct_id"],
        }
        groups = context.get("groups")
        if groups is not None:
            body[_WIRE_GROUPS_KEY] = groups
        person_properties = context.get("person_properties")
        if person_properties is not None:
            body[_WIRE_PERSON_PROPERTIES_KEY] = person_properties
        group_properties = context.get("group_properties")
        if group_properties is not None:
            body[_WIRE_GROUP_PROPERTIES_KEY] = group_properties
        flag_keys = context.get("flag_keys")
        if flag_keys is not None:
            body[_WIRE_FLAG_KEYS_KEY] = flag_keys
        return body


# A structural conformance anchor: mypy checks the adapter satisfies the neutral port here, so a
# drift from FeatureFlagPort fails typecheck at the module boundary (not deep in a consumer).
_PORT_CONFORMANCE: type[FeatureFlagPort] = HttpFlagAdapter
