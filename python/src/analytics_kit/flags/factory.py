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
    """Assemble the local-eval capability when a definitions endpoint + the privileged credential are
    configured; ``None`` otherwise (remote-only). The effective local-only value follows the reference
    default ``only_evaluate_locally ?? False``."""
    if config.definitions_endpoint is None or config.definitions_key is None:
        return None
    poller = DefinitionPoller(
        definitions_endpoint=config.definitions_endpoint,
        definitions_key=config.definitions_key,
        token=config.key or "",
        poll_interval=config.poll_interval if config.poll_interval is not None else _DEFAULT_POLL_INTERVAL,
        transport=config.transport,
    )
    only_locally = config.only_evaluate_locally or False
    return LocalEvalCapability(poller, only_locally)
