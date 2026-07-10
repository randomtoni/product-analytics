"""The bar-B ENFORCEMENT gate — an AST import-audit asserting public-API-only imports.

This is one of the TWO gates the architect ruled together constitute the Python bar-B proof (the
other is the FIDELITY gate — ``uv run mypy .`` type-checking the example against the INSTALLED
``analytics-kit`` public types via ``py.typed``). Python needs BOTH because it has no physical
``dist`` boundary the way TypeScript does:

- The FIDELITY gate (installed-dist mypy) proves the example type-checks against the installed
  distribution's public types with ZERO ``analytics_kit`` edits — but mypy resolves a DEEP import
  (``import analytics_kit.provider``) just as happily as a public one.
- The ENFORCEMENT gate (this audit) proves the example reaches ONLY the public API — no internals.
  Nothing else can enforce this alone: ``__all__`` does not block a deep import, the internals
  cannot be excluded from the wheel (the public factories need them at runtime), and Python has no
  ``exports`` map to physically gate resolution.

So neither gate subsumes the other — do NOT "simplify" this back to a single gate; deleting either
silently drops half the bar-B proof.

WHY AST, not grep: ``ast.parse`` sees aliased (``from x import y as z``) and multi-line imports
structurally, so an internal reach cannot hide behind a line break or a rename.
"""

from __future__ import annotations

import ast
from pathlib import Path

# The example project root (two levels up from this test file: tests/ -> <project>/).
_EXAMPLE_ROOT = Path(__file__).resolve().parent.parent

# The EXACT public import surface an example may reach. An ``analytics_kit``-rooted import is
# allowed IFF its dotted module path is one of these; anything DEEPER is a violation.
#   - ``analytics_kit``            — the top-level namespace (its ``__all__`` is the public surface)
#   - ``analytics_kit.integrations`` — the middleware + context accessors' public re-export point
#   - ``analytics_kit.query``      — the curated public query subpackage (own ``__all__``)
#   - ``analytics_kit.server``     — the curated public server subpackage (own ``__all__``)
#   - ``analytics_kit.taxonomy``   — the PY3-S3 typing-recipe re-export point (own ``__all__``:
#                                    ``Protocol``/``TypedDict``/``cast`` for the consumer typed view)
_PUBLIC_MODULES = {
    "analytics_kit",
    "analytics_kit.integrations",
    "analytics_kit.query",
    "analytics_kit.server",
    "analytics_kit.taxonomy",
}

_ROOT = "analytics_kit"


def _is_private_name(name: str) -> bool:
    """A name is private if it is underscore-prefixed (covers ``_WIRE_*`` and any ``_x``)."""
    return name.startswith("_")


def audit_source(source: str, *, origin: str) -> list[str]:
    """Return a list of bar-B violations found in ``source`` (empty ⇒ clean).

    Walks every ``import``/``from ... import`` node. For ``analytics_kit``-rooted imports it flags:
    - a module path DEEPER than the public allow-list (e.g. ``analytics_kit.provider``,
      ``analytics_kit.integrations.django``);
    - any imported NAME that is underscore-prefixed (``_WIRE_*`` / ``_private``), even from a
      public module.
    """
    violations: list[str] = []
    tree = ast.parse(source, filename=origin)

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                module = alias.name
                if module == _ROOT or module.startswith(f"{_ROOT}."):
                    if module not in _PUBLIC_MODULES:
                        violations.append(
                            f"{origin}: `import {module}` reaches outside the public surface"
                        )
        elif isinstance(node, ast.ImportFrom):
            # ``from . import x`` (relative) is intra-example — level > 0, not analytics_kit-rooted.
            if node.level > 0 or node.module is None:
                continue
            module = node.module
            if module != _ROOT and not module.startswith(f"{_ROOT}."):
                continue
            if module not in _PUBLIC_MODULES:
                violations.append(
                    f"{origin}: `from {module} import ...` reaches outside the public surface"
                )
                continue
            for alias in node.names:
                if _is_private_name(alias.name):
                    violations.append(
                        f"{origin}: `from {module} import {alias.name}` imports a private name"
                    )

    return violations


def _example_python_files() -> list[Path]:
    """Every real ``*.py`` in the example (src + tests), excluding tooling caches."""
    files: list[Path] = []
    for base in ("src", "tests"):
        for path in sorted((_EXAMPLE_ROOT / base).rglob("*.py")):
            parts = set(path.parts)
            if "__pycache__" in parts or ".venv" in parts:
                continue
            files.append(path)
    return files


def test_every_example_import_of_the_library_is_public() -> None:
    files = _example_python_files()
    # Guard against a vacuous pass: the audit must actually be walking real example modules.
    assert any(p.name == "test_framework_binding.py" for p in files)
    assert any(p.name == "typed_view.py" for p in files)

    all_violations: list[str] = []
    for path in files:
        source = path.read_text(encoding="utf-8")
        all_violations.extend(audit_source(source, origin=str(path.relative_to(_EXAMPLE_ROOT))))

    assert all_violations == [], "bar-B enforcement gate violated:\n" + "\n".join(all_violations)


# --- negative control: PARSED STRINGS proving the audit FLAGS internal reaches ----------------
#
# These are source STRINGS handed to the audit's parse routine — NOT live imports in a shipped
# example module. A real internal import here would itself fail the FIDELITY gate and contaminate
# the bar-B diff; the string form proves the audit's ``from ... import ...`` parse path fires on a
# deliberately-internal reach without shipping one.

_DEEP_PROVIDER = "from analytics_kit.provider import Analytics"
_DEEP_MIDDLEWARE = "from analytics_kit.integrations.django import RequestContextMiddleware"
_DEEP_CONTEXT = "from analytics_kit.integrations.context import context"
_DEEP_IMPORT_STMT = "import analytics_kit.factory"
_PRIVATE_NAME = "from analytics_kit import _WIRE_capture"


def test_negative_control_flags_a_deep_from_import() -> None:
    assert audit_source(_DEEP_PROVIDER, origin="<control>") != []


def test_negative_control_flags_a_deeper_subpackage_import() -> None:
    # ``analytics_kit.integrations`` is public, but ``.integrations.django`` is a level deeper.
    assert audit_source(_DEEP_MIDDLEWARE, origin="<control>") != []
    assert audit_source(_DEEP_CONTEXT, origin="<control>") != []


def test_negative_control_flags_a_deep_plain_import_statement() -> None:
    assert audit_source(_DEEP_IMPORT_STMT, origin="<control>") != []


def test_negative_control_flags_a_private_name_from_a_public_module() -> None:
    assert audit_source(_PRIVATE_NAME, origin="<control>") != []


def test_public_imports_are_not_flagged() -> None:
    # The positive control — the audit does not false-positive on the real public surface the
    # framework exercise + the typed-view recipe legitimately use.
    clean = "\n".join(
        [
            "import analytics_kit",
            "from analytics_kit import create_analytics, NeutralEvent",
            "from analytics_kit.integrations import RequestContextASGIMiddleware, context, add_tag",
            "from analytics_kit.query import create_query_client",
            "from analytics_kit.server import create_server_analytics",
            "from analytics_kit.taxonomy import Protocol, TypedDict, cast",
            "from quillstream import create_quillstream_analytics",
            "from . import config",
        ]
    )
    assert audit_source(clean, origin="<control>") == []
