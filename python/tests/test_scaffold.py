import analytics_kit


def test_package_imports_with_version() -> None:
    assert analytics_kit.__version__ == "0.0.0"
