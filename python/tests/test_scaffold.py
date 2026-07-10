import analytics_kit
import analytics_kit.adapter
import analytics_kit.allowlist
import analytics_kit.client
import analytics_kit.integrations
import analytics_kit.neutral_event
import analytics_kit.ports
import analytics_kit.query
import analytics_kit.taxonomy


def test_package_imports_with_version() -> None:
    assert analytics_kit.__version__ == "0.0.0"


def test_submodules_import() -> None:
    assert analytics_kit.client is not None
    assert analytics_kit.query is not None
    assert analytics_kit.taxonomy is not None
    assert analytics_kit.allowlist is not None
    assert analytics_kit.integrations is not None
    assert analytics_kit.neutral_event is not None
    assert analytics_kit.adapter is not None
    assert analytics_kit.ports is not None
