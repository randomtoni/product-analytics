"""Unkeyed whole-stack no-op: an unconfigured environment sends nothing (bar B).

The unkeyed harness passes NO adapter, so the seam-default ``NoopAdapter`` backs the whole stack:
every verb is a silent no-op and no recorder exists to inspect. This proves the bar-B no-op
posture — a new app that adopts by config alone, without a key, is working-but-silent, never
erroring. S1 pinned only that the unkeyed branch does not route through a recorder; here every
ingest verb is driven end-to-end and the whole stack stays silent.
"""

from __future__ import annotations

from quillstream import create_quillstream_analytics
from quillstream.config import quillstream_config


def test_unkeyed_harness_is_a_silent_whole_stack_no_op() -> None:
    harness = create_quillstream_analytics(quillstream_config())

    # No recorder is injected — the NoopAdapter backs the stack, so there is nothing to record TO.
    assert harness.recorder is None

    # Every ingest verb completes silently against the no-op — nothing is delivered, nothing raises.
    harness.analytics.capture("user-1", "workspace_created", {"plan": "pro", "seats": 5})
    harness.analytics.set("user-1", {"role": "editor"})
    harness.analytics.set_group_traits("workspace", "ws-1", {"name": "Acme", "seats": 25})
    harness.analytics.flush()
    harness.analytics.shutdown()
