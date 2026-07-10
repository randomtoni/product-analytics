"""Allowlist loud-failure: the privacy contract as an executable consumer proof (E3).

A deliberate off-list PII key (``ssn``) must fail LOUDLY. This is the Python realization of TS
``E10-S5``, but the compile-vs-runtime routing DIFFERS (read the story's Technical notes): the
server provider has no ``register`` runtime verb, and the shipped ``Analytics.capture`` runtime
signature is already loose (``properties: dict[str, object] | None``). So an off-list ``ssn`` key
on the PLAIN provider is NOT a mypy error — it is directly a RUNTIME allowlist ``ValueError``.
The off-list demonstration is therefore routed through the UNTYPED provider view; the whole
example still type-checks under strict mypy.

Under the default ``throw`` policy the off-list key raises before any mint; under
``drop-and-error-log`` it is dropped (recorder stream clean) and error-logged once. On-list keys
still record under BOTH policies — the CONTRACT's regression pin.
"""

from __future__ import annotations

import logging

import pytest

from analytics_kit import Analytics, AnalyticsConfig, create_analytics

from quillstream import RecordingAdapter
from quillstream.config import quillstream_config


def _throw_wiring() -> tuple[Analytics, RecordingAdapter]:
    recorder = RecordingAdapter()
    analytics = create_analytics(quillstream_config(key="k"), adapter=recorder)
    return analytics, recorder


def _drop_wiring() -> tuple[Analytics, RecordingAdapter]:
    recorder = RecordingAdapter()
    drop_config: AnalyticsConfig = quillstream_config(key="k").model_copy(
        update={"on_violation": "drop-and-error-log"}
    )
    analytics = create_analytics(drop_config, adapter=recorder)
    return analytics, recorder


def test_off_list_key_raises_loudly_under_throw() -> None:
    analytics, recorder = _throw_wiring()

    # Routed through the UNTYPED provider view (properties is dict[str, object] | None), so `ssn`
    # is a RUNTIME violation, not a mypy error — the whole example still type-checks strict.
    with pytest.raises(ValueError, match=r'property "ssn" is not on the payload allowlist'):
        analytics.capture("user-1", "workspace_created", {"ssn": "123-45-6789"})

    # The loud failure fires BEFORE the adapter is touched — nothing off-list recorded.
    assert recorder.captures == []


def test_off_list_key_is_dropped_and_error_logged_under_drop_policy(
    caplog: pytest.LogCaptureFixture,
) -> None:
    analytics, recorder = _drop_wiring()

    with caplog.at_level(logging.ERROR, logger="analytics_kit"):
        # No throw under the drop policy — the off-list capture is silently dropped.
        analytics.capture("user-1", "workspace_created", {"ssn": "123-45-6789"})

    # Nothing off-list reaches the recorder: the capture stream is clean.
    assert recorder.captures == []

    # Exactly one error-level violation is logged (loud in the logs, not the control flow).
    violations = [
        r for r in caplog.records
        if r.levelno == logging.ERROR and "is not on the payload allowlist" in r.getMessage()
    ]
    assert len(violations) == 1
    assert 'property "ssn"' in violations[0].getMessage()


def test_on_list_keys_still_record_under_throw() -> None:
    # Regression pin (throw half): on-list keys are unaffected by the presence of the guard.
    analytics, recorder = _throw_wiring()

    analytics.capture("user-1", "workspace_created", {"plan": "pro", "seats": 5})

    assert len(recorder.captures) == 1
    assert recorder.captures[0].event == "workspace_created"
    assert recorder.captures[0].properties is not None
    assert recorder.captures[0].properties["plan"] == "pro"


def test_on_list_keys_still_record_under_drop_policy(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # Regression pin (the CONTRACT's crux): switching to drop-and-error-log must NOT gate on-list
    # keys. An on-list capture still records; only the off-list key is suppressed.
    analytics, recorder = _drop_wiring()

    with caplog.at_level(logging.ERROR, logger="analytics_kit"):
        analytics.capture("user-1", "workspace_created", {"plan": "pro", "seats": 5})
        analytics.capture("user-1", "workspace_created", {"ssn": "123-45-6789"})

    assert len(recorder.captures) == 1
    assert recorder.captures[0].properties is not None
    assert recorder.captures[0].properties["plan"] == "pro"
    # And the off-list drop still logged its single violation.
    violations = [
        r for r in caplog.records
        if r.levelno == logging.ERROR and "is not on the payload allowlist" in r.getMessage()
    ]
    assert len(violations) == 1
