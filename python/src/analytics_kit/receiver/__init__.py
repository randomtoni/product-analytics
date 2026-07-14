"""The receiver package — the WRITE side of self-host.

The framework-agnostic core lives here (S1); the S2/S4 framework mounts and the S3 from-config
factory join it as thin edges of this same package, mirroring how ``query/`` holds both the seam
and the default driver. The core parses the node batch envelope the transport speaks and upserts
each event into the library-owned ``events`` table (E17) through the injected ``DbExecute`` seam.

The framework mounts are re-exported LAZILY (via ``__getattr__``, the convention COPIED from
``integrations/__init__.py`` — not shared with it): a bare ``import analytics_kit.receiver`` never
pulls a web framework, and each mount module — which imports its framework only when the handler is
built — is loaded only when the name is actually accessed.
"""

from __future__ import annotations

from typing import Any

from .config import ReceiverConfig
from .factory import create_receiver_from_config
from .receiver import (
    Accepted,
    MalformedBody,
    ReceiveOutcome,
    Receiver,
    ReceiverHeaders,
)

__all__ = [
    "Receiver",
    "ReceiverHeaders",
    "ReceiveOutcome",
    "Accepted",
    "MalformedBody",
    "ReceiverConfig",
    "create_receiver_from_config",
    "make_receiver_view",
    "ReceiverASGIApp",
]

_LAZY_EXPORTS = {
    "make_receiver_view": ".django_mount",
    "ReceiverASGIApp": ".asgi_mount",
}


def __getattr__(name: str) -> Any:
    module_path = _LAZY_EXPORTS.get(name)
    if module_path is not None:
        from importlib import import_module

        module = import_module(module_path, __name__)
        return getattr(module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
