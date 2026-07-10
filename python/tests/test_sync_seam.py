"""Sync-client lifecycle seam + the ``sync_mode`` delivery flag.

This is the seam only: the posture is *sync client with a background daemon thread, no
asyncio*, and the flag/contract that later delivery plugs into. The tests pin the
``sync_mode`` config field (additive, known under ``extra="forbid"``), the provider's
``flush``/``shutdown`` as synchronous drain-to-completion delegating to the adapter, and a
guard that no threading/asyncio delivery has leaked into the seam yet — the queue, thread,
and exit-time join belong to the server-capture cycle.
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path

from analytics_kit import (
    Analytics,
    AnalyticsConfig,
    ConsentState,
    NeutralEvent,
    NeutralResponse,
    create_analytics,
)


class _RecordingAdapter:
    """Capture-only adapter that records every lifecycle call for delegation assertions."""

    def __init__(self) -> None:
        self.captured: list[NeutralEvent] = []
        self.flushed = 0
        self.shut_down = 0
        self._consent: ConsentState = "granted"

    def capture(self, event: NeutralEvent) -> None:
        self.captured.append(event)

    def flush(self) -> None:
        self.flushed += 1

    def shutdown(self) -> None:
        self.shut_down += 1

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        return NeutralResponse(status=200, body="")

    def get_consent_state(self) -> ConsentState:
        return self._consent

    def set_consent_state(self, state: ConsentState) -> None:
        self._consent = state

    def get_library_id(self) -> str:
        return "analytics-kit"

    def get_library_version(self) -> str:
        return "0.0.0"


# --- sync_mode config flag (additive, known under extra="forbid") -----------------------


def test_sync_mode_defaults_to_false() -> None:
    assert AnalyticsConfig().sync_mode is False


def test_sync_mode_true_parses() -> None:
    assert AnalyticsConfig(sync_mode=True).sync_mode is True


def test_sync_mode_false_parses() -> None:
    assert AnalyticsConfig(sync_mode=False).sync_mode is False


def test_sync_mode_is_a_known_field_not_rejected_by_extra_forbid() -> None:
    # A known field passes the extra="forbid" gate; a typo of it still raises loudly.
    config = create_analytics({"sync_mode": True}, _RecordingAdapter())
    assert isinstance(config, Analytics)


def test_sync_mode_coexists_with_other_config_fields() -> None:
    config = AnalyticsConfig(key="k1", super_properties={"v": "1"}, sync_mode=True)

    assert config.key == "k1"
    assert config.super_properties == {"v": "1"}
    assert config.sync_mode is True


# --- provider lifecycle: sync drain-to-completion delegating to the adapter --------------


def test_flush_is_synchronous_not_a_coroutine() -> None:
    assert not inspect.iscoroutinefunction(Analytics.flush)


def test_shutdown_is_synchronous_not_a_coroutine() -> None:
    assert not inspect.iscoroutinefunction(Analytics.shutdown)


def test_flush_delegates_to_adapter_flush() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)

    provider.flush()

    assert adapter.flushed == 1
    assert adapter.shut_down == 0


def test_shutdown_delegates_to_adapter_shutdown() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter)

    provider.shutdown()

    assert adapter.shut_down == 1
    assert adapter.flushed == 0


def test_flush_returns_after_the_delegated_drain_returns() -> None:
    # Drain-to-completion: the adapter's flush has fully run by the time flush() returns.
    order: list[str] = []

    class _OrderingAdapter(_RecordingAdapter):
        def flush(self) -> None:
            order.append("adapter.flush")

    provider = Analytics(_OrderingAdapter())
    provider.flush()
    order.append("provider.flush returned")

    assert order == ["adapter.flush", "provider.flush returned"]


# --- seam guard: no threading / asyncio delivery has leaked in yet -----------------------


_SEAM_MODULES = ("provider", "config", "factory", "noop", "adapter")

_FORBIDDEN_IMPORTS = {"asyncio", "threading", "queue", "atexit", "concurrent.futures"}
_FORBIDDEN_TOP = {name.split(".")[0] for name in _FORBIDDEN_IMPORTS}


def _seam_source(module: str) -> str:
    import analytics_kit

    package_dir = Path(inspect.getfile(analytics_kit)).parent
    return (package_dir / f"{module}.py").read_text()


def test_seam_declares_posture_without_threading_or_asyncio() -> None:
    for module in _SEAM_MODULES:
        tree = ast.parse(_seam_source(module))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    top = alias.name.split(".")[0]
                    assert top not in _FORBIDDEN_TOP, (
                        f"{module}.py imports {alias.name} — delivery is the server-capture "
                        "cycle's scope, not the seam's"
                    )
            elif isinstance(node, ast.ImportFrom):
                assert node.module not in _FORBIDDEN_IMPORTS and (
                    node.module or ""
                ).split(".")[0] not in _FORBIDDEN_TOP, (
                    f"{module}.py imports from {node.module} — delivery is the "
                    "server-capture cycle's scope, not the seam's"
                )


def test_seam_has_no_async_def() -> None:
    for module in _SEAM_MODULES:
        tree = ast.parse(_seam_source(module))
        for node in ast.walk(tree):
            assert not isinstance(node, ast.AsyncFunctionDef), (
                f"{module}.py defines an async function — the posture is sync, no asyncio"
            )
