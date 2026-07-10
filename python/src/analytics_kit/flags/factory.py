"""The config-selected flag-client factory — bar B for the flag-eval surface.

``create_flag_client`` is how a consumer wires a flag client by configuration alone. Selection
mirrors the query factory's shape and the TS-node ``create-flag-client`` split:

- no ``key`` (or a key set but no ``flag_endpoint``) ⇒ the silent :class:`FlagNoop` (bar B — an
  unconfigured environment resolves nothing, never an exception);
- ``key`` + ``flag_endpoint`` present ⇒ the remote-eval :class:`HttpFlagAdapter` branch.

The flag-eval key is DISTINCT from the ingest write key and the query read key, and is read only
here, server-side. The HTTP-adapter branch constructs the
:class:`~analytics_kit.flags.adapter.HttpFlagAdapter` (context→wire, blocking POST, wire→snapshot
decode); its wire vocabulary is sealed inside that module and never surfaces here.
"""

from __future__ import annotations

from ..ports import FeatureFlagPort
from .adapter import HttpFlagAdapter
from .config import FlagClientConfig
from .noop import FlagNoop


def create_flag_client(config: FlagClientConfig) -> FeatureFlagPort:
    """Build a flag client from configuration, selecting the no-op or the remote adapter.

    Unkeyed (or keyed-but-endpointless) yields the whole-surface no-op; a keyed + endpointed
    config selects the remote-eval adapter. Both satisfy the SAME neutral ``FeatureFlagPort``
    (bar A) — how the client is obtained differs, what the consumer gets does not.
    """
    if config.key is None or config.flag_endpoint is None:
        return FlagNoop()
    return HttpFlagAdapter(
        key=config.key,
        flag_endpoint=config.flag_endpoint,
        bootstrap=config.bootstrap,
        transport=config.transport,
    )
