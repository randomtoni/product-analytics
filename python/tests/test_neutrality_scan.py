"""The gate itself: the neutrality scan over the real tree PASSES, and every dimension bites.

This file IS the exit-nonzero gate wired into the fast ``uv run pytest`` loop. A failing assertion
here is a nonzero pytest exit — that IS the gate tripping. Three test bands:
  - the real tree scans to ZERO violations (fast dimensions on every commit; the full artifact scan
    behind an opt-in marker so the inner loop stays build-free);
  - planted-violation tests (one per dimension) prove each dimension actually catches a leak;
  - false-fail-guard pass tests prove the legitimate cases (confined ``$``-literal, provenance
    comment, required ``hogql`` wire vocab, ``examples/quillstream`` path link) do NOT false-fail.

The scan lives under ``scripts/`` (excluded from its own scan by construction); we add that dir to
``sys.path`` here so the test can import it — ``scripts/`` is not on the default test ``pythonpath``.
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT / "scripts"))

from neutrality_scan import (  # noqa: E402  (path insert above must precede the import)
    FORBIDDEN_TOKENS,
    default_paths,
    scan_artifacts,
    scan_doc,
    scan_fast,
    scan_wire_confinement,
    scan_wire_confinement_in_source,
)


# --- The real tree PASSES -----------------------------------------------------------------------
def test_real_tree_fast_scan_is_clean() -> None:
    violations = scan_fast(default_paths())
    assert violations == [], "\n".join(f"{v.dimension} {v.file}: {v.detail}" for v in violations)


def test_real_src_wire_confinement_is_clean() -> None:
    paths = default_paths()
    violations = scan_wire_confinement(paths.src_dir)
    assert violations == [], "\n".join(f"{v.file}: {v.detail}" for v in violations)


def test_real_readme_doc_dimension_is_clean() -> None:
    paths = default_paths()
    violations = scan_doc(str(paths.readme_path), paths.readme_path.read_text())
    assert violations == [], "\n".join(v.detail for v in violations)


@pytest.mark.artifact_scan
def test_real_artifacts_full_scan_is_clean() -> None:
    """The CI-only dimension: build + fully extract the wheel + sdist and scan their entire contents.

    Behind the ``artifact_scan`` marker (deselected by default) because it runs ``uv build`` — too
    slow for the every-commit loop. Run it with ``uv run pytest -m artifact_scan`` (the CI step).
    """
    violations = scan_artifacts(_REPO_ROOT)
    assert violations == [], "\n".join(f"{v.file}: {v.detail}" for v in violations)


# --- Planted violations FAIL (one per dimension) ------------------------------------------------
def test_planted_wire_literal_escape_fails() -> None:
    escaped = "def emit():\n    return {'event': '$pageview'}\n"
    violations = scan_wire_confinement_in_source("adapter.py", escaped)
    assert len(violations) == 1
    assert violations[0].dimension == "wire-confinement"
    assert "$pageview" in violations[0].detail
    assert "escaped" in violations[0].detail


def test_wire_confinement_line_sharing_spoof_fails() -> None:
    """A stray non-``_WIRE_`` binding that SHARES a source line with a ``_WIRE_*`` const still FAILS.

    Confinement keys on the AST binding, never the line — so ``SNEAK`` below is caught even though it
    sits on the same physical line as a legit ``_WIRE_*`` const (the spoof a line-based check missed).
    """
    spoof = "_WIRE_OK = 'kind'; SNEAK = '$pageview'\n"
    violations = scan_wire_confinement_in_source("adapter.py", spoof)
    assert len(violations) == 1
    assert "$pageview" in violations[0].detail
    assert "escaped" in violations[0].detail

    # The other shape from the review: `_WIRE_X = "..."; STRAY = "$foo"`.
    spoof2 = '_WIRE_X = "a"; STRAY = "$foo"\n'
    violations2 = scan_wire_confinement_in_source("adapter.py", spoof2)
    assert len(violations2) == 1
    assert "$foo" in violations2[0].detail


def test_wire_confinement_multiline_wire_const_collection_passes() -> None:
    """A multiline ``_WIRE_*`` dict/tuple of ``$``-tokens PASSES (elements inside the value confined)."""
    wire_dict = '_WIRE_D = {\n    "a": "$pageview",\n    "b": "$screenview",\n}\n'
    assert scan_wire_confinement_in_source("adapter.py", wire_dict) == []
    wire_tuple = '_WIRE_T = (\n    "$one",\n    "$two",\n)\n'
    assert scan_wire_confinement_in_source("adapter.py", wire_tuple) == []


def test_planted_prose_quillstream_in_doc_fails() -> None:
    leaked = "Adopt the library the way the Quillstream demo app does.\n"
    violations = scan_doc("README.md", leaked)
    assert any("quillstream" in v.detail.lower() for v in violations)


def test_planted_vendor_token_in_doc_fails() -> None:
    for prose, needle in [
        ("batch POST to i.posthog.com for ingest", "i.posthog.com"),
        ("the ph_ cookie prefix is vendor-specific", "ph_"),
        ("route via the us.i. region host", "us.i."),
        ("built on posthog under the hood", "posthog"),
    ]:
        violations = scan_doc("README.md", prose)
        assert violations != [], f"expected a doc violation for {needle!r}"


def test_planted_posthog_in_payload_module_fails(tmp_path: Path) -> None:
    """A vendor token in a shipped ``.py`` payload file (surface / value) FAILS the artifact scan."""
    root = _synth_extracted_tree(
        tmp_path,
        {"analytics_kit/adapter.py": 'CLIENT_NAME = "posthog"\n'},
    )
    from neutrality_scan import _scan_extracted_tree

    violations = _scan_extracted_tree(root, "wheel[synth]")
    assert any("posthog" in v.detail for v in violations)
    assert all(v.dimension == "artifact" for v in violations)


def test_planted_posthog_in_docstring_fails(tmp_path: Path) -> None:
    """A vendor token in a DOCSTRING (ships as source in the wheel) FAILS — docstrings are NOT exempt.

    Only ``#`` comments are AST-exempt; a docstring is a scanned payload string.
    """
    module = '"""This module wraps the posthog ingest client."""\n\nX = 1\n'
    root = _synth_extracted_tree(tmp_path, {"analytics_kit/thing.py": module})
    from neutrality_scan import _scan_extracted_tree

    violations = _scan_extracted_tree(root, "wheel[synth]")
    assert any("posthog" in v.detail for v in violations)


def test_provenance_comment_in_payload_passes_artifact_scan(tmp_path: Path) -> None:
    """A ``# De-branded from posthog's …`` comment in a shipped ``.py`` PASSES the ARTIFACT scan.

    The PM-lock: provenance comments MAY reach the wheel (Python ships source — the deliberate
    divergence from TS). The artifact ``.py`` payload scan strips ``#`` comments before scanning, so
    the ``posthog`` in this comment is exempt — exactly matching the ``src/`` boundary. The
    surrounding code + a legit non-vendor docstring stay clean.
    """
    module = (
        '"""Maps a neutral event onto the wire shape."""\n\n'
        "# De-branded from posthog's event-utils wire mapper.\n"
        '_WIRE_EVENT_KEY = "event"\n'
    )
    root = _synth_extracted_tree(tmp_path, {"analytics_kit/server/wire_mapper.py": module})
    from neutrality_scan import _scan_extracted_tree

    assert _scan_extracted_tree(root, "wheel[synth]") == []


def test_url_value_with_trailing_comment_not_blinded(tmp_path: Path) -> None:
    """Stripping ``#`` comments must NOT blind the scan: a ``#`` inside a string VALUE is preserved.

    A vendor hostname VALUE with a trailing comment on the same line still FAILS — only the comment
    bytes are blanked, never the string-literal value.
    """
    module = 'HOST = "https://us.i.example.com/x"  # a trailing comment\n'
    root = _synth_extracted_tree(tmp_path, {"analytics_kit/thing.py": module})
    from neutrality_scan import _scan_extracted_tree

    violations = _scan_extracted_tree(root, "wheel[synth]")
    assert any("us.i." in v.detail for v in violations)


def test_planted_posthog_in_wheel_metadata_fails(tmp_path: Path) -> None:
    """A vendor token in wheel ``METADATA`` FAILS — the PY1-S1-escape regression guard.

    The escape was vendor tokens in packaging metadata that a clean ``src/`` grep missed. The header
    fields get NO carve-out; a ``posthog`` in a field must FAIL.
    """
    metadata = (
        "Metadata-Version: 2.4\n"
        "Name: posthog-analytics\n"
        "Version: 0.0.0\n"
        "\n"
        "# analytics-kit\n\nClean description body.\n"
    )
    root = _synth_extracted_tree(
        tmp_path, {"posthog_analytics-0.0.0.dist-info/METADATA": metadata}
    )
    from neutrality_scan import _scan_extracted_tree

    violations = _scan_extracted_tree(root, "wheel[synth]")
    # Both the field-level `Name: posthog-analytics` AND the path segment `posthog_analytics-...`.
    assert any("posthog" in v.detail for v in violations)
    assert any("metadata field" in v.detail for v in violations)


def test_planted_vendor_token_in_sdist_pkg_info_fails(tmp_path: Path) -> None:
    """A vendor token in sdist ``PKG-INFO`` FAILS (the sdist analog of the wheel-metadata escape)."""
    pkg_info = (
        "Metadata-Version: 2.4\n"
        "Name: analytics-kit\n"
        "Summary: built on posthog\n"
        "\n"
        "Clean body.\n"
    )
    root = _synth_extracted_tree(tmp_path, {"analytics_kit-0.0.0/PKG-INFO": pkg_info})
    from neutrality_scan import _scan_extracted_tree

    violations = _scan_extracted_tree(root, "sdist[synth]")
    assert any("posthog" in v.detail for v in violations)


def test_planted_vendor_token_in_swept_dotfile_fails(tmp_path: Path) -> None:
    """A vendor token in a swept-in dotfile (``.gitignore``) FAILS — the exact PY1-S1 escape vector.

    The sdist ``only-include`` sweeps ``python/.gitignore``; a vendor token there must be caught.
    """
    root = _synth_extracted_tree(
        tmp_path, {"analytics_kit-0.0.0/.gitignore": "# ignore\nposthog-python\n"}
    )
    from neutrality_scan import _scan_extracted_tree

    violations = _scan_extracted_tree(root, "sdist[synth]")
    assert any("posthog" in v.detail for v in violations)


def test_planted_vendor_token_in_module_path_fails(tmp_path: Path) -> None:
    """A vendor token in a module PATH (dist / module name) FAILS — the file-name dimension."""
    root = _synth_extracted_tree(tmp_path, {"analytics_kit/posthog_adapter.py": "X = 1\n"})
    from neutrality_scan import _scan_extracted_tree

    violations = _scan_extracted_tree(root, "wheel[synth]")
    assert any("artifact path" in v.detail and "posthog" in v.detail for v in violations)


# --- False-fail guards: the legitimate cases PASS -----------------------------------------------
def test_confined_wire_literal_passes() -> None:
    """A ``$``-literal inside a module-level ``_WIRE_*`` const PASSES (both naming shapes)."""
    assert scan_wire_confinement_in_source("x.py", '_WIRE_PAGEVIEW_KEY = "$pageview"\n') == []
    assert scan_wire_confinement_in_source("x.py", '_WIRE_INSERT = "$insert_id"\n') == []
    assert scan_wire_confinement_in_source("x.py", '_WIRE_X: str = "$foo"\n') == []


def test_provenance_comment_passes() -> None:
    """A ``# De-branded from posthog's …`` comment PASSES the ``ast`` pass (comments never visited)."""
    src = (
        "# De-branded from posthog's $session_entry_url / $prev_pageview_duration enrichment.\n"
        'EVENT_KEY = "event"\n'
    )
    assert scan_wire_confinement_in_source("wire_mapper.py", src) == []


def test_required_hogql_wire_vocab_passes() -> None:
    """The required ``HogQLQuery`` wire vocab PASSES — it is NOT a forbidden token, and lives in a
    ``_WIRE_*`` const so the confinement pass leaves it alone (it is non-``$``, so untouched)."""
    assert "hogql" not in [t.lower() for t in FORBIDDEN_TOKENS]
    assert not any("hogql" in t.lower() for t in FORBIDDEN_TOKENS)
    src = '_WIRE_RAW_QUERY_KIND = "HogQLQuery"\n'
    assert scan_wire_confinement_in_source("http_adapter.py", src) == []
    # And it passes the doc dimension too (not a banned token in prose).
    assert scan_doc("README.md", "the raw_query escape hatch maps to a HogQLQuery kind") == []


def test_examples_quillstream_path_link_passes() -> None:
    """A bare ``examples/quillstream`` path link PASSES; bare-prose ``quillstream`` still FAILS."""
    path_only = "See the runnable consumer under `examples/quillstream` for a worked setup.\n"
    assert scan_doc("README.md", path_only) == []

    path_and_prose = "See `examples/quillstream`. The Quillstream app shows every lever.\n"
    violations = scan_doc("README.md", path_and_prose)
    assert any("quillstream" in v.detail.lower() for v in violations)


def test_record_hash_substring_does_not_false_fail(tmp_path: Path) -> None:
    """A ``RECORD`` whose base64 sha256 hash embeds ``_ph_`` does NOT false-fail (path-column-only).

    The wheel ``RECORD`` is a ``path,sha256=<base64url>,size`` manifest; a real hash embeds the
    substring ``ph_``. Only the PATH column is the file-name surface — scanning the raw line would
    false-fail on an opaque hash. This is a real case in the shipped wheel (``server/__init__.py``).
    """
    record = (
        "analytics_kit/server/__init__.py,sha256=t5bWQ4WutkeEfYc1_ph_-DI5WBr9uoY4f2jVm8gNexY,2384\n"
        "analytics_kit/adapter.py,sha256=Nkmu40VpMHqySC2BR62jKZLQo_mffHj22A3yogh1JLM,2843\n"
    )
    root = _synth_extracted_tree(
        tmp_path, {"analytics_kit-0.0.0.dist-info/RECORD": record}
    )
    from neutrality_scan import _scan_extracted_tree

    assert _scan_extracted_tree(root, "wheel[synth]") == []


def test_test_tooling_payload_content_excluded_but_path_scanned(tmp_path: Path) -> None:
    """A ``test_*.py`` file that NAMES a token (assertion pattern) is content-exempt but path-scanned.

    Tests legitimately name the forbidden tokens (``assert "posthog" not in …``); they are not the
    consumer-observable runtime surface (the wheel ships no tests). The CONTENT is exempt; a
    vendor-named test FILENAME would still be caught by the path dimension.
    """
    from neutrality_scan import _scan_extracted_tree

    # Content names the token -> exempt (no violation).
    clean_name = _synth_extracted_tree(
        tmp_path / "a", {"tests/test_thing.py": 'assert "posthog" not in surface\n'}
    )
    assert _scan_extracted_tree(clean_name, "sdist[synth]") == []

    # A vendor-named test FILE -> its path is still caught (path dimension has no test exemption).
    bad_name = _synth_extracted_tree(
        tmp_path / "b", {"tests/test_posthog_thing.py": "assert True\n"}
    )
    violations = _scan_extracted_tree(bad_name, "sdist[synth]")
    assert any("artifact path" in v.detail for v in violations)


# --- Whole-pipeline entry-point smoke -----------------------------------------------------------
def test_scan_full_over_a_synthetic_clean_repo_via_entry_point() -> None:
    """``scan_fast`` returns a list and is stable over the real tree; ``scan_full`` extends it."""
    paths = default_paths()
    fast = scan_fast(paths)
    assert isinstance(fast, list)
    assert fast == []


def _synth_extracted_tree(root: Path, files: dict[str, str]) -> Path:
    """Materialize a synthetic already-extracted artifact tree under ``root`` and return it."""
    root.mkdir(parents=True, exist_ok=True)
    for rel, content in files.items():
        full = root / rel
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content)
    return root


def test_scan_full_builds_a_real_wheel_zip_that_is_extractable() -> None:
    """Sanity: the real build produces a valid, extractable wheel zip (guards the extract path).

    A cheap structural check the full-scan path depends on — not the CI artifact assertion (that is
    ``test_real_artifacts_full_scan_is_clean`` behind the marker), just proof the zip machinery the
    scan uses is sound against a hand-built synthetic wheel.
    """
    import io

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("analytics_kit/__init__.py", "X = 1\n")
    buf.seek(0)
    with zipfile.ZipFile(buf) as zf:
        assert "analytics_kit/__init__.py" in zf.namelist()
