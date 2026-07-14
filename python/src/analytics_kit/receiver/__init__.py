"""The receiver package — the WRITE side of self-host.

The framework-agnostic core lives here (S1); the S2/S4 framework mounts and the S3 from-config
factory join it as thin edges of this same package, mirroring how ``query/`` holds both the seam
and the default driver. The core parses the node batch envelope the transport speaks and upserts
each event into the library-owned ``events`` table (E17) through the injected ``DbExecute`` seam.
"""

from __future__ import annotations

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
]
