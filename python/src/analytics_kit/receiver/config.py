"""The receiver's own config boundary — the WRITE-side twin of the query ``QueryClientConfig``.

``ReceiverConfig`` carries the SAME ``warehouse_dsn`` field SHAPE as the query config (C symmetry),
so self-host reads as one coherent "here's my Neon" across read (query) and write (receiver). A
credential-shaped value: read at the :func:`create_receiver_from_config` factory boundary, never
stored on the receiver core or a mount. Its PRESENCE selects the DSN-built receiver — there is no
``backend:`` enum.

It carries the SAME ``model_config`` posture as ``QueryClientConfig``: ``extra="forbid"`` so a config
typo raises loudly rather than silently degrading.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class ReceiverConfig(BaseModel):
    """The consumer-supplied receiver configuration the factory parses.

    ``warehouse_dsn`` is the explicit self-host signal — its presence selects the DSN-built
    receiver; its shape mirrors ``QueryClientConfig.warehouse_dsn``. Unknown keys are rejected
    loudly.
    """

    model_config = ConfigDict(extra="forbid")

    warehouse_dsn: str | None = None
