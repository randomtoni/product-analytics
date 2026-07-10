"""S1 substrate tests: the recorder conforms to the seam, records, and the harness branches.

These are the harness-level guarantees the rest of the epic builds on. The capture/query/
allowlist exercise (S2) and the framework binding + bar-B gate (S3) layer on top.
"""

from __future__ import annotations

from analytics_kit import AnalyticsAdapter

from quillstream import RecordingAdapter, create_quillstream_analytics
from quillstream.config import quillstream_config


def _conforms(adapter: AnalyticsAdapter) -> AnalyticsAdapter:
    """Structural sink: passes iff the argument satisfies the AnalyticsAdapter Protocol.

    Under strict mypy this line fails to type-check if RecordingAdapter is missing or
    mis-typing any of the Protocol's eight members.
    """
    return adapter


def test_recording_adapter_conforms_to_the_seam() -> None:
    recorder = RecordingAdapter()
    assert _conforms(recorder) is recorder


def test_recording_adapter_grants_consent() -> None:
    assert RecordingAdapter().get_consent_state() == "granted"


def test_keyed_harness_records_captured_events() -> None:
    harness = create_quillstream_analytics(quillstream_config(key="quillstream-ingest-key"))
    assert harness.recorder is not None

    harness.analytics.capture("user-1", "workspace_created", {"plan": "pro", "seats": 5})
    harness.analytics.capture("user-1", "document_created", {"document_id": "doc-1", "template": "blank"})

    assert len(harness.recorder.captures) == 2
    assert harness.recorder.captures[0].event == "workspace_created"
    assert harness.recorder.captures[1].event == "document_created"


def test_unkeyed_harness_injects_no_recorder() -> None:
    harness = create_quillstream_analytics(quillstream_config())
    assert harness.recorder is None

    # The harness never injected a recorder, so the seam's own default (NoopAdapter) backs the
    # stack — a working-but-silent no-op obtained by config alone. The whole-stack no-op
    # assertion (nothing is delivered) is S2's exercise; here we pin only that the branch does
    # NOT route through the recorder.
    harness.analytics.capture("user-1", "workspace_created", {"plan": "pro", "seats": 5})
