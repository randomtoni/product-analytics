"""The inbound config boundary — validated with Pydantic.

Config is the one genuine inbound boundary: consumer-supplied and untrusted-ish, so it is
parsed and validated. The neutral event, wire envelope, and internal data stay plain
dataclasses/TypedDicts — library-built and trusted-by-construction. ``AnalyticsConfig``
carries only what the seam needs today; later cycles extend it additively (taxonomy and
allowlist, ingest endpoint and queue tuning, the query config).
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from .allowlist import ViolationPolicy
from .ports import FlagValue
from .taxonomy import Taxonomy


class FlagBootstrap(BaseModel):
    """Server-rendered flag data seeded synchronously at construction, before any ``evaluate``.

    Neutral field names (``flags``/``payloads``, never a vendor ``feature_flag*`` prefix). A
    nested model so ``extra="forbid"`` rejects a typo'd sub-key loudly rather than silently
    dropping it.
    """

    model_config = ConfigDict(extra="forbid")

    flags: dict[str, FlagValue] | None = None
    payloads: dict[str, object] | None = None


class FlagsConfig(BaseModel):
    """Feature-flag settings the server flag adapter reads — ``flag_endpoint`` + ``bootstrap`` + the
    local-eval knobs.

    ``flag_endpoint`` is the flag-eval round-trip origin, kept SEPARATE from the ingest
    ``ingest_host``: a flag decision endpoint differs from the ingest endpoint (mirroring the
    query client's separate ``query_endpoint``), so the two never alias. A single endpoint (not
    the split host/path of ingest). When present alongside a top-level ``key``, the server target
    attaches a flag client to the provider's ``flags`` slot; absent, the slot stays ``None``.
    ``bootstrap`` is the neutral server-rendered seed served as a fallback when a round-trip
    fails.

    The local-eval knobs — ``definitions_endpoint``, ``definitions_key``, ``poll_interval``,
    ``only_evaluate_locally``, ``strict_local_evaluation`` — select and tune in-process evaluation:
    a definitions endpoint + the privileged ``definitions_key`` (a definition-reading credential
    named BY ROLE, distinct from the top-level ``key``) makes the attached flag client local-capable
    (poll definitions, evaluate in-process, fall back to the remote round-trip). A local-capable
    client is attached even WITHOUT a ``flag_endpoint`` (the local-only posture). A nested model so a
    typo'd key still trips ``extra="forbid"``.
    """

    model_config = ConfigDict(extra="forbid")

    flag_endpoint: str | None = None
    bootstrap: FlagBootstrap | None = None
    definitions_endpoint: str | None = None
    definitions_key: str | None = None
    poll_interval: float | None = None
    only_evaluate_locally: bool | None = None
    strict_local_evaluation: bool | None = None


class AnalyticsConfig(BaseModel):
    """The consumer-supplied configuration the factory parses.

    ``key`` presence drives adapter selection: unkeyed configuration yields a whole-stack
    silent no-op. ``super_properties`` are merged into every captured event by the provider.
    ``sync_mode`` selects the delivery posture: ``True`` delivers inline (no background
    thread); ``False`` (default) offloads delivery to a background daemon thread. The flag
    is the contract only — both delivery paths are wired in the server-capture cycle.
    ``allowlist`` is the consumer-supplied payload allowlist (``None`` ⇒ inactive; an
    explicit empty list ⇒ allow-nothing); ``on_violation`` selects the enforcement policy.
    ``taxonomy`` is the :func:`define_taxonomy` return value — an opaque, non-Pydantic
    object held via an ``isinstance(value, Taxonomy)`` check (``arbitrary_types_allowed``),
    so a raw dict fails at this boundary rather than with an ``AttributeError`` later.
    Supplying a taxonomy never auto-activates the allowlist. ``ingest_host``/``ingest_path``
    are the split ingest-endpoint fields the server target reads (a host and a path, never a
    single combined endpoint); there is no vendor default, so an absent ``ingest_host`` is a
    consumer misconfiguration. ``flush_at``/``flush_interval``/``max_batch_size``/
    ``max_queue_size`` tune the server batch consumer (buffer size trigger, interval trigger in
    seconds, max records per delivery, max buffered events); unset uses the locked defaults.
    ``shutdown_timeout`` bounds the drain ``shutdown()`` races against (seconds) before it
    settles deterministically; ``retry_count``/``retry_delay`` bound the fixed-delay transient
    retry budget on delivery (``retry_count`` retries after the first attempt ⇒ ``retry_count + 1``
    total attempts, each spaced by ``retry_delay`` seconds). ``flags`` carries the feature-flag
    settings — ``flags.flag_endpoint`` (the flag-eval round-trip origin, distinct from
    ``ingest_host``) and ``flags.bootstrap`` (server-rendered flag data seeded at construction,
    neutral ``flags``/``payloads`` field names); when a ``flag_endpoint`` is set alongside a
    ``key`` the server target attaches a flag client to the provider's ``flags`` slot, else the
    slot stays ``None``. Unknown keys are rejected loudly — a config typo raises rather than
    silently degrading.
    """

    model_config = ConfigDict(extra="forbid", arbitrary_types_allowed=True)

    key: str | None = None
    super_properties: dict[str, object] | None = None
    sync_mode: bool = False
    allowlist: list[str] | None = None
    on_violation: ViolationPolicy = "throw"
    taxonomy: Taxonomy | None = None
    ingest_host: str | None = None
    ingest_path: str | None = None
    flush_at: int = 20
    flush_interval: float = 10.0
    max_batch_size: int = 100
    max_queue_size: int = 1000
    shutdown_timeout: float = 30.0
    retry_count: int = 3
    retry_delay: float = 3.0
    flags: FlagsConfig | None = None
