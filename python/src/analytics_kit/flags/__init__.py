"""The feature-flag target — the server remote-eval flag client and its config-selected factory.

The Python analog of the TS-node flag client: a server-shaped remote-eval adapter satisfying the
neutral :class:`~analytics_kit.FeatureFlagPort` (``evaluate`` → blocking round-trip → snapshot,
``distinct_id`` required, once-fire ``on_change``), its separate :class:`FlagClientConfig` (own
key + flag endpoint, distinct from ingest/query), the config-selected :func:`create_flag_client`
factory, and the :class:`FlagNoop` null object (bar B).

Two ways to reach the capability, both satisfying the SAME neutral port (bar A): the standalone
:func:`create_flag_client` (a flag client with its own credential/endpoint, mirroring
``create_query_client``), and the provider ``flags`` slot the server target populates when the
ingest config carries a ``key`` + ``flags.flag_endpoint``.
"""

from .adapter import HttpFlagAdapter
from .config import FlagClientConfig
from .factory import create_flag_client
from .noop import FlagNoop
from .transport import FlagTransport

__all__ = [
    "FlagClientConfig",
    "FlagTransport",
    "HttpFlagAdapter",
    "FlagNoop",
    "create_flag_client",
]
