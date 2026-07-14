"""The config-selected flag-client factory — bar B for the flag-eval surface.

``create_flag_client`` is how a consumer wires a flag client by configuration alone. Selection
mirrors the query factory's shape and the TS-node ``create-flag-client`` split:

- no ``key`` ⇒ the silent :class:`FlagNoop` (bar B — an unconfigured environment resolves nothing,
  never an exception);
- ``key`` + a definitions endpoint + the privileged ``definitions_key`` ⇒ the LOCAL-CAPABLE
  :class:`HttpFlagAdapter` (poll definitions, evaluate in-process, fall back to the remote
  round-trip when configured), even WITHOUT a ``flag_endpoint`` (the local-only posture);
- ``key`` + ``flag_endpoint`` (no local config) ⇒ the remote-only :class:`HttpFlagAdapter` branch,
  exactly as E12 shipped;
- ``key`` but NEITHER a ``flag_endpoint`` NOR a local-eval config ⇒ the no-op (genuinely nowhere to
  evaluate).

The flag-eval key is DISTINCT from the ingest write key and the query read key, and the privileged
``definitions_key`` is distinct again — all read only here, server-side. The HTTP-adapter branch
constructs the :class:`~analytics_kit.flags.adapter.HttpFlagAdapter`; its wire vocabulary (and the
local machinery's) is sealed inside those modules and never surfaces here.
"""

from __future__ import annotations

from ..ports import FeatureFlagPort
from .adapter import HttpFlagAdapter, LocalEvalCapability
from .config import FlagClientConfig
from .local import DefinitionPoller
from .local.neutral_definition import lower_definitions, validate_definitions
from .noop import FlagNoop

# The definition poll cadence when the consumer doesn't tune it — a sensible server default.
_DEFAULT_POLL_INTERVAL = 30.0


def create_flag_client(config: FlagClientConfig) -> FeatureFlagPort:
    """Build a flag client from configuration, selecting the no-op, the remote adapter, or the
    local-capable adapter.

    Unkeyed yields the whole-surface no-op. A keyed config with a definitions endpoint + the
    privileged credential selects the local-capable adapter (even without a ``flag_endpoint`` — the
    local-only posture); a keyed config with only a ``flag_endpoint`` stays remote-only; a keyed
    config with neither is the no-op. All satisfy the SAME neutral ``FeatureFlagPort`` (bar A) — how
    the client is obtained differs, what the consumer gets does not.
    """
    if config.key is None:
        return FlagNoop()

    local = _build_local_capability(config)
    if local is None and config.flag_endpoint is None:
        return FlagNoop()

    return HttpFlagAdapter(
        key=config.key,
        flag_endpoint=config.flag_endpoint,
        bootstrap=config.bootstrap,
        transport=config.transport,
        local=local,
    )


def _build_local_capability(config: FlagClientConfig) -> LocalEvalCapability | None:
    """Assemble the local-eval capability. Two selectors, in this order:

    1. STATIC definitions (the fully-local self-host default) — ``static_definitions`` present ⇒ a
       SEEDED poller carrying the lowered snapshot, with NO definitions endpoint / privileged
       credential / transport. The definition source is config, so the client makes zero definition
       fetches. Validated loudly here (raises the config-layer ``ValidationError`` at construction on
       a malformed set), then lowered via S1's ``lower_definitions``.
    2. The definitions endpoint + the privileged credential (the poller-fetch path) — unchanged.

    ``None`` when neither selector fires (remote-only). A local capability from EITHER selector is a
    real route, so the factory's "keyed but no route ⇒ no-op" guard does not swallow a static-defs
    local-only config. The effective local-only value follows the reference default
    ``only_evaluate_locally or False``."""
    only_locally = config.only_evaluate_locally or False
    if config.static_definitions is not None:
        # Validate at the input boundary so a malformed static set fails LOUDLY at client construction
        # (Pydantic ValidationError — the config-layer error type), not lazily at first eval. Then
        # lower to the wire snapshot and seed a poller that structurally cannot fetch.
        validate_definitions(config.static_definitions)
        poller = DefinitionPoller.seeded(lower_definitions(config.static_definitions))
        return LocalEvalCapability(poller, only_locally)

    if config.definitions_endpoint is None or config.definitions_key is None:
        return None
    poller = DefinitionPoller(
        definitions_endpoint=config.definitions_endpoint,
        definitions_key=config.definitions_key,
        token=config.key or "",
        poll_interval=config.poll_interval if config.poll_interval is not None else _DEFAULT_POLL_INTERVAL,
        transport=config.transport,
    )
    return LocalEvalCapability(poller, only_locally)
