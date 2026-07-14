"""The config-selected receiver factory — the single ergonomic top-level entry for the write side.

``create_receiver_from_config`` is the receiver analog of
:func:`~analytics_kit.query.create_query_client`: a ``warehouse_dsn`` in → a mount-ready
:class:`~analytics_kit.receiver.Receiver` out. It is the WRITE-side twin of the query
:func:`~analytics_kit.query.warehouse_adapter.create_warehouse_query_adapter_from_config` (read the
DSN at the boundary, build the default :class:`DbExecute` from it, inject it), differing only in that
this is the consumer's DIRECT entry — so it takes the FULL :class:`ReceiverConfig` with the optional
``warehouse_dsn`` and does the presence check itself (there is no receiver equivalent of
``create_query_client`` guarding presence ahead of it).

Selection is by field PRESENCE — a ``warehouse_dsn`` supplied ⇒ a DSN-built receiver; absent ⇒ a
clear neutral error. There is no ``backend:`` enum. The default-driver import stays behind the
``analytics-kit[warehouse]`` extra — importing this module does not import the driver; only
CONSTRUCTING the default driver (inside :func:`create_default_db_execute`) does. The DSN→driver build
is an internal detail here: the returned ``Receiver`` never holds a DSN or a driver handle.
"""

from __future__ import annotations

from ..query.default_db_execute import create_default_db_execute
from .config import ReceiverConfig
from .receiver import Receiver

_MISSING_WAREHOUSE_DSN = (
    "analytics-kit: a receiver requires a warehouse_dsn to select the self-host write target — "
    "set warehouse_dsn on the ReceiverConfig or supply your own DbExecute via Receiver(...)."
)


def create_receiver_from_config(config: ReceiverConfig) -> Receiver:
    """Build a mount-ready :class:`Receiver` from configuration, selecting by field PRESENCE.

    ``warehouse_dsn`` present ⇒ build the default :class:`DbExecute` driver from the DSN and inject
    it into the receiver core; the consumer then hands the returned ``Receiver`` to any mount
    (``make_receiver_view`` / ``ReceiverASGIApp``) — config-only self-host adoption, zero library
    edit.

    Absent ``warehouse_dsn`` raises a clear neutral :class:`RuntimeError` naming the missing field
    (NOT a silent no-op). Unlike the query factory's :class:`QueryNoop` — where an unconfigured read
    is a well-formed empty result — a WRITE receiver has no natural empty-success state: a receiver
    with no warehouse to write to cannot silently accept-and-drop events (data loss dressed as
    success). So this diverges from the query factory DELIBERATELY, mirroring the default-driver's
    clear-neutral-error posture. The error names no vendor and no transport concept.
    """
    if config.warehouse_dsn is None:
        raise RuntimeError(_MISSING_WAREHOUSE_DSN)
    return Receiver(create_default_db_execute(config.warehouse_dsn))
