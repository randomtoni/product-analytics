"""Bar-A re-proof (gated adapter swap) + bar-B pointer — the two acceptance bars, re-runnable.

**Bar A — provider-swap = one adapter, zero consumer change.** The SAME ``create_analytics(config,
adapter=...)`` call site flows a ``NoopAdapter`` ↔ a ``RecordingAdapter`` (a first-party test adapter
satisfying the SPI structurally) with the provider facade BYTE-IDENTICAL across the swap — the
behavioral difference (Noop records nothing; Recording captures the event) lives ENTIRELY behind the
seam. Paired with an on-paper second-adapter design over the REAL ``AnalyticsAdapter`` SPI (the
8-member structural Protocol in ``adapter.py:32-81``). The Python realization of TS ``E11-S3``.

**Bar B — new-app adoption = config only, zero library change.** NOT reinvented here: the standing
bar-B proof is PY7's Quillstream TWO-GATE model, referenced (not rebuilt) by
``test_bar_b_points_at_the_quillstream_two_gate_proof`` below:

* FIDELITY gate — the example type-checks against the INSTALLED ``analytics-kit`` public types
  (``cd python/examples/quillstream && uv run mypy .``).
* ENFORCEMENT gate — the AST import-audit (``python/examples/quillstream/tests/test_bar_b_import_audit.py``)
  with the FIVE-entry public allow-list ``{analytics_kit, analytics_kit.integrations,
  analytics_kit.query, analytics_kit.server, analytics_kit.taxonomy}``.

Python needs BOTH because it has no physical ``dist`` boundary the way TypeScript does (mypy resolves
a deep import as happily as a public one, and the internals can't be excluded from the wheel).

Audit-not-patch: this file (and its siblings) touch ONLY ``python/tests/**`` — zero ``analytics_kit``
source edits, verifiable by diff.
"""

from __future__ import annotations

from analytics_kit import (
    AnalyticsConfig,
    ConsentState,
    NeutralEvent,
    NeutralResponse,
    NoopAdapter,
    create_analytics,
)
from analytics_kit.version import __version__


class RecordingAdapter:
    """A first-party test adapter satisfying the 8-member ``AnalyticsAdapter`` Protocol structurally.

    It records captured events in memory instead of hitting a network — the "second adapter" in the
    bar-A swap. It imports/subclasses NO library base (structural conformance is the whole point of
    the neutral seam).
    """

    def __init__(self) -> None:
        self.captured: list[NeutralEvent] = []
        self._consent: ConsentState = "granted"

    def capture(self, event: NeutralEvent) -> None:
        self.captured.append(event)

    def flush(self) -> None:
        pass

    def shutdown(self) -> None:
        pass

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        return NeutralResponse(status=0, body="")

    def get_consent_state(self) -> ConsentState:
        return self._consent

    def set_consent_state(self, state: ConsentState) -> None:
        self._consent = state

    def get_library_id(self) -> str:
        return "analytics-kit"

    def get_library_version(self) -> str:
        return __version__


# The REAL AnalyticsAdapter SPI — the finite fill-in-the-blanks list a new backend satisfies.
# Counted from adapter.py:40-81: all 8 are methods (no non-method members). A new adapter fills
# EXACTLY these 8 and nothing else — facade/config/taxonomy/consumer untouched.
_ANALYTICS_ADAPTER_SPI = (
    "capture",
    "flush",
    "shutdown",
    "send",
    "get_consent_state",
    "set_consent_state",
    "get_library_id",
    "get_library_version",
)


def _public_facade(provider: object) -> list[str]:
    """The provider's public verb/attr surface — callables and public data attrs, sorted.

    A byte-identical facade across the adapter swap proves the consumer surface does not change:
    the difference lives entirely behind the seam.
    """
    names = [name for name in dir(provider) if not name.startswith("_")]
    return sorted(names)


# --- bar A: the on-paper second-adapter design is EXACTLY the 8-member SPI -------------------


def test_second_adapter_design_enumerates_the_real_8_member_spi() -> None:
    # The design lists precisely the AnalyticsAdapter Protocol members (adapter.py:32-81) — 8, all
    # methods. A new backend fills THESE 8; the count is verified against the real Protocol below.
    from analytics_kit.adapter import AnalyticsAdapter

    protocol_members = {name for name in dir(AnalyticsAdapter) if not name.startswith("_")}
    assert protocol_members == set(_ANALYTICS_ADAPTER_SPI)
    assert len(_ANALYTICS_ADAPTER_SPI) == 8


def test_both_adapters_satisfy_the_full_spi_structurally() -> None:
    # Both the shipped NoopAdapter and the test RecordingAdapter fill every SPI member — the
    # fill-in-the-blanks surface a new backend satisfies, with no shared base class.
    for adapter in (NoopAdapter(), RecordingAdapter()):
        for member in _ANALYTICS_ADAPTER_SPI:
            assert callable(getattr(adapter, member)), f"{type(adapter).__name__}.{member}"


# --- bar A: the gated swap — same call site, byte-identical facade, difference behind the seam


def test_swap_flows_both_adapters_through_one_call_site_with_an_identical_facade() -> None:
    config = AnalyticsConfig(key="k")

    # The SAME create_analytics(config, adapter=...) call site, two different adapters.
    noop_provider = create_analytics(config, adapter=NoopAdapter())
    recording_provider = create_analytics(config, adapter=RecordingAdapter())

    # The consumer facade is BYTE-IDENTICAL across the swap (same public verb surface).
    assert _public_facade(noop_provider) == _public_facade(recording_provider)
    # Sanity: the facade actually carries the verbs a consumer codes against (not vacuously empty).
    facade = _public_facade(noop_provider)
    for verb in ("capture", "set", "set_group_traits", "flush", "shutdown", "opt_out"):
        assert verb in facade


def test_the_same_sequence_differs_only_behind_the_seam() -> None:
    config = AnalyticsConfig(key="k")
    recorder = RecordingAdapter()

    noop_provider = create_analytics(config, adapter=NoopAdapter())
    recording_provider = create_analytics(config, adapter=recorder)

    # ONE neutral sequence, run identically against either backend (zero consumer change).
    def drive(provider: object) -> None:
        provider.capture("user-42", "signup_started", {"plan": "pro"})  # type: ignore[attr-defined]

    drive(noop_provider)
    drive(recording_provider)

    # The behavioral difference lives ENTIRELY behind the seam: Noop records nothing, Recording
    # captures the event. The consumer code (drive) was identical.
    assert recorder.captured != []
    assert recorder.captured[0].event == "signup_started"
    assert recorder.captured[0].distinct_id == "user-42"


def test_unkeyed_config_selects_the_silent_noop_by_config_alone() -> None:
    # Bar A's zero-config-change corollary: the seam default (no adapter supplied) is the silent
    # NoopAdapter — a working-but-silent stack obtained by configuration alone, same call site.
    provider = create_analytics(AnalyticsConfig())
    provider.capture("user-1", "order_placed", {"amount": 1})
    # Facade is the same as the keyed path (only the adapter behind the seam differs).
    keyed = create_analytics(AnalyticsConfig(key="k"), adapter=RecordingAdapter())
    assert _public_facade(provider) == _public_facade(keyed)


# --- bar B: point at (do NOT reinvent) the PY7 Quillstream two-gate proof --------------------


def test_bar_b_points_at_the_quillstream_two_gate_proof() -> None:
    """Bar B is the standing PY7 Quillstream two-gate proof — referenced, not rebuilt here.

    This test asserts the enforcement-gate file (the AST import-audit with the five-entry public
    allow-list) EXISTS and carries that allow-list, so the reference is live rather than a dead
    prose pointer. The fidelity gate (installed-dist mypy) + this enforcement gate are re-run green
    by the epic-close gate command; see the module docstring.
    """
    from pathlib import Path

    quillstream_tests = (
        Path(__file__).resolve().parents[1] / "examples" / "quillstream" / "tests"
    )
    import_audit = quillstream_tests / "test_bar_b_import_audit.py"
    assert import_audit.exists(), "the PY7 bar-B enforcement gate must exist to be referenced"

    source = import_audit.read_text(encoding="utf-8")
    for public_module in (
        "analytics_kit",
        "analytics_kit.integrations",
        "analytics_kit.query",
        "analytics_kit.server",
        "analytics_kit.taxonomy",
    ):
        assert public_module in source, f"the five-entry allow-list must include {public_module}"
