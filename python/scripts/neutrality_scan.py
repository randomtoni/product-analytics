"""The standing zero-vendor gate — the Python realization of ``ts/scripts/neutrality-scan.ts``.

Why NOT a raw ``grep`` over ``src/`` (architect-locked): a raw text grep is the WRONG tool and
would both false-fail and under-scan —
  1. it false-fails on the port-provenance ``# De-branded from posthog's …`` comments, dev-facing
     audit evidence that a port was de-branded rather than copied;
  2. it false-fails on the confined wire vocabulary (the query-kind discriminators like
     ``"HogQLQuery"``) that rides requests but never crosses onto the neutral surface;
  3. it UNDER-scans: a ``src/`` grep misses vendor tokens that live only in the BUILT artifact —
     wheel ``METADATA`` / sdist ``PKG-INFO`` / a swept-in ``.gitignore`` — the exact PY1-S1 escape.
So the scan classifies by DIMENSION (what a consumer can observe), not by raw text:
  - the ARTIFACT dimension builds + fully extracts the wheel + sdist and walks their entire
    contents — payload ``.py``/``.pyi`` (surface + string-literal VALUES + docstrings), packaging
    metadata (``METADATA``/``PKG-INFO``/``RECORD``/swept-in dotfiles), and the distribution + module
    names — the ONLY dimension that certifies what a consumer actually installs;
  - the WIRE-CONFINEMENT dimension is an ``ast`` pass over ``src/`` (string literals only — a
    ``$``-token or vendor mention inside a ``#`` comment is not a literal and is never visited),
    passing a wire literal ONLY as the value of a module-level ``_WIRE_*`` constant;
  - the DOC dimension scans ``README.md`` prose.
NOT a ruff plugin (ruff cannot scan the built wheel) and NOT raw grep (per the above). Anyone
reaching for ``grep -r`` should read this and stop.

Two callable entry points:
  - ``scan_fast(paths)`` — the src ``ast`` pass + the doc pass. Cheap (no build); wired into the
    every-commit ``uv run pytest`` gate.
  - ``scan_full(paths)`` — ``scan_fast`` PLUS the wheel/sdist build-extract-scan. Needs a build, so
    it is CI-only (building the wheel per commit is too slow for the inner loop).

The provenance-comment boundary is EXACT: the ``ast`` pass never visits ``#`` comments, so
``# De-branded from posthog's …`` is exempt by construction (and the epic PM-locks that it MAY
reach the shipped wheel — Python ships source; a documented divergence from TS, which strips such
comments from ``dist``). BUT docstrings ship as source in the wheel ``.py`` files and packaging
metadata ships in ``METADATA``/``PKG-INFO`` — a vendor token in EITHER FAILS. The ONLY AST-exempt
category is ``#`` comments.

SELF-SCAN gotcha (handled structurally): this script NAMES the forbidden tokens ("posthog",
"quillstream", the hostnames) as its own match patterns, so it would self-fail if it were ever
scanned. It never is: every dimension is anchored to ``src/analytics_kit/`` (the ``ast`` pass), the
built wheel/sdist (the artifact pass), or the doc paths — ``scripts/`` is under none of them, so
this file is excluded from its own scan by construction. Keep it OUT of ``src/`` and it stays clean.
"""

from __future__ import annotations

import ast
import io
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tokenize
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

# Case-insensitive vendor/product tokens forbidden on the surface. Region hostnames are listed as
# their distinctive host fragments. ``quillstream`` is the invented example product name — it
# belongs ONLY in an ``examples/quillstream`` path, never in the library surface or in prose.
# ``hogql``/``HogQLQuery`` is DELIBERATELY ABSENT: it is REQUIRED confined wire vocabulary (the
# ``_WIRE_RAW_QUERY_KIND`` value in the query adapter), proven contained by the wire-confinement
# dimension — banning it would be unsatisfiable.
FORBIDDEN_TOKENS: tuple[str, ...] = (
    "posthog",
    "ph_",
    "i.posthog.com",
    "us.i.",
    "eu.i.",
    "quillstream",
)

# The product-name path carve-out: ``quillstream`` is allowed ONLY as an ``examples/quillstream``
# path link (mirroring the TS ``examples/fernly`` carve-out). Stripped before the ``quillstream``
# check so a path link passes while bare-prose ``quillstream`` still fails. No OTHER token has a
# carve-out anywhere.
_EXAMPLE_PATH_CARVE_OUT = re.compile(r"examples/quillstream", re.IGNORECASE)

# The confinement convention: a wire string literal is PERMITTED only as the value of a
# MODULE-LEVEL constant whose name begins ``_WIRE_``. Anchored on the ``_WIRE_`` PREFIX, so BOTH
# naming shapes pass — ``wire_mapper.py``'s ``_WIRE_*_KEY`` (trailing ``_KEY``) and
# ``http_adapter.py``'s suffix-free ``_WIRE_RAW_QUERY_KIND`` / ``_WIRE_BEARER_SCHEME``. A new
# adapter's wire token passes this SAME gate with ZERO scan edits iff it obeys the convention —
# a rule, not a per-value whitelist (a whitelist would ship a token registry in-repo and need
# editing for every new adapter).
_WIRE_CONST_NAME = re.compile(r"^_WIRE_")


@dataclass(frozen=True)
class Violation:
    dimension: str
    file: str
    detail: str


@dataclass
class RepoScanPaths:
    """The roots each dimension is anchored to (self-scan safe: ``scripts/`` is under none)."""

    repo_root: Path
    src_dir: Path
    readme_path: Path
    # Extra shipped docs land here as more README-adjacent files; they pass the SAME doc gate with
    # zero other edits. Empty this cycle — the one doc target is ``README.md`` (S1 pinned the parity
    # matrix INTO the README, not a forked ``PARITY.md``).
    extra_doc_paths: list[Path] = field(default_factory=list)


def _lower_includes(haystack: str, needle: str) -> bool:
    return needle.lower() in haystack.lower()


def _find_forbidden(text: str) -> list[str]:
    return [tok for tok in FORBIDDEN_TOKENS if _lower_includes(text, tok)]


def _find_forbidden_with_carveout(text: str) -> list[str]:
    """Find forbidden tokens, applying the ``examples/quillstream`` path carve-out to prose.

    The carve-out is per-TOKEN: ``quillstream`` is checked against text with its ``examples/``
    path occurrences stripped (so a path link passes, bare prose fails); every other token is
    checked against the unstripped text (no carve-out anywhere).
    """
    without_example_path = _EXAMPLE_PATH_CARVE_OUT.sub("", text)
    hits: list[str] = []
    for tok in FORBIDDEN_TOKENS:
        haystack = without_example_path if tok.lower() == "quillstream" else text
        if _lower_includes(haystack, tok):
            hits.append(tok)
    return hits


# --- Wire-confinement dimension: an ``ast`` pass over ``src/`` ---------------------------------
#
# Classify wire STRING LITERALS in one src module. Uses ``ast`` so classification is literal-scoped,
# not text-scoped: a ``$``-token or a vendor mention inside a ``#`` comment is not a string-literal
# node and is never visited here (this is the provenance-comment exemption, by construction). A
# docstring IS a string literal and IS visited — but it is never the value of a ``_WIRE_*`` const,
# so a wire-shaped docstring would (correctly) fail; a plain-prose docstring carries no wire literal
# so it passes this dimension (its vendor tokens are caught by the artifact dimension instead).
#
# A wire literal PASSES only when it is the initializer value of a MODULE-LEVEL ``_WIRE_*`` const.
# It FAILS anywhere else — an escaped-confinement leak. "Wire-shaped" today means a ``$``-prefixed
# literal (a forward-consistency guard — no shipped Python literal is ``$``-prefixed, since ``$``
# props are a browser-only enrichment absent server-side). The query-dialect vocabulary
# (``"HogQLQuery"`` et al.) is non-``$`` and lives in ``_WIRE_*`` consts by construction; the
# confinement rule is what keeps that vocab contained.
def _confined_wire_literals(tree: ast.Module) -> set[int]:
    """The ``id()`` set of ``$``-string-literal NODES confined inside a module-level ``_WIRE_*`` const.

    Confinement keys on the AST BINDING, never the source line: a ``$``-literal is confined IFF its
    enclosing statement is a MODULE-LEVEL ``_WIRE_*`` ``Assign``/``AnnAssign`` and the literal lives
    inside that assignment's VALUE (directly, or as an element of the value's collection/dict — a
    ``_WIRE_*`` dict/tuple of wire tokens is legit). A stray non-``_WIRE_`` binding that merely SHARES
    a physical source line with a ``_WIRE_*`` const is NOT confined — the exact spoof a line-based
    check would miss. Mirrors the TS ``isConfinedWireLiteral`` (parent-binding, not line).
    """
    confined: set[int] = set()
    for node in tree.body:  # module-level statements only (direct children of the module body)
        target_names: list[str] = []
        value: ast.expr | None = None
        if isinstance(node, ast.Assign):
            target_names = [t.id for t in node.targets if isinstance(t, ast.Name)]
            value = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            target_names = [node.target.id]
            value = node.value
        if value is None:
            continue
        if any(_WIRE_CONST_NAME.match(name) for name in target_names):
            for lit in ast.walk(value):
                if isinstance(lit, ast.Constant) and isinstance(lit.value, str):
                    confined.add(id(lit))
    return confined


def scan_wire_confinement_in_source(file_path: str, source: str) -> list[Violation]:
    tree = ast.parse(source)
    confined = _confined_wire_literals(tree)
    violations: list[Violation] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if node.value.startswith("$") and id(node) not in confined:
                violations.append(
                    Violation(
                        dimension="wire-confinement",
                        file=file_path,
                        detail=f'wire literal "{node.value}" escaped a module-level _WIRE_* const',
                    )
                )
    return violations


def _is_test_tooling_file(path: Path) -> bool:
    """A test-tooling file — dev tooling that legitimately NAMES the forbidden tokens as assertion
    patterns / planted violations, never a consumer-observable runtime surface.

    Mirrors the TS ``isTestToolingFile``: the true invariant is import-graph reachability from the
    package's public surface (does this file ship in the installed WHEEL?). The wheel ships no
    tests; the sdist sweeps ``tests/`` only as a rebuild convenience. We approximate reachability by
    enumerating the test-tooling patterns actually present — pytest's ``test_*.py`` / ``*_test.py``
    discovery plus ``conftest.py``. Applied ONLY to the payload-CONTENT scan (a real leak in a
    shipped ``src/`` ``.py`` is NOT a test file and still fails); the path/name dimension scans
    every path including test filenames with NO exemption.
    """
    name = path.name
    return name.startswith("test_") or name.endswith("_test.py") or name == "conftest.py"


def scan_wire_confinement(src_dir: Path) -> list[Violation]:
    violations: list[Violation] = []
    for file in sorted(src_dir.rglob("*.py")):
        violations.extend(scan_wire_confinement_in_source(str(file), file.read_text()))
    return violations


# --- Doc dimension ------------------------------------------------------------------------------
def scan_doc(doc_path: str, content: str) -> list[Violation]:
    """Scan doc prose. EVERY forbidden token fails; the ONE carve-out is an ``examples/quillstream``
    PATH link (``quillstream`` in bare prose still fails). All other tokens have no carve-out."""
    violations: list[Violation] = []
    for tok in _find_forbidden_with_carveout(content):
        detail = (
            'forbidden token "quillstream" in prose '
            '(only an "examples/quillstream" path link is allowed)'
            if tok.lower() == "quillstream"
            else f'forbidden token "{tok}" in shipped doc'
        )
        violations.append(Violation(dimension="doc", file=doc_path, detail=detail))
    return violations


def scan_docs(paths: RepoScanPaths) -> list[Violation]:
    violations: list[Violation] = []
    for doc in [paths.readme_path, *paths.extra_doc_paths]:
        try:
            content = doc.read_text()
        except OSError:
            continue
        violations.extend(scan_doc(str(doc), content))
    return violations


# --- Artifact dimension: the built wheel + sdist ------------------------------------------------
#
# Python has no tsup/dist — the shipped artifact is the wheel + sdist (payload ≈ ``src/`` + packaging
# metadata). This maps the TS ``declaration`` + ``js-bundle`` + ``package-name`` + ``file-name``
# dimensions onto Python's shipped artifacts. Both are FULLY extracted and their ENTIRE contents
# walked — the PY1-S1-escape fix: scan the fully-extracted artifacts, not ``src/`` (the escape was
# vendor tokens in wheel ``METADATA`` / sdist ``PKG-INFO`` / a swept-in root ``.gitignore`` that a
# clean ``src/`` grep missed).

# Metadata files whose body embeds the README long-description verbatim — the description block gets
# the SAME doc carve-out (it IS embedded doc prose), while the structured header fields (``Name:``,
# ``RECORD`` paths, dist/module names) get NO carve-out.
_DESCRIPTION_METADATA_NAMES = ("METADATA", "PKG-INFO")
_PAYLOAD_SUFFIXES = (".py", ".pyi")


def _build_artifacts(repo_root: Path, out_dir: Path) -> tuple[Path, Path]:
    """Build the wheel + sdist into ``out_dir`` and return ``(wheel_path, sdist_path)``.

    Prefers ``uv build`` (the project toolchain); falls back to ``python -m build``.
    """
    if shutil.which("uv") is not None:
        cmd = ["uv", "build", "--out-dir", str(out_dir)]
    else:
        cmd = [sys.executable, "-m", "build", "--outdir", str(out_dir)]
    subprocess.run(cmd, cwd=repo_root, check=True, capture_output=True, text=True)
    wheels = list(out_dir.glob("*.whl"))
    sdists = list(out_dir.glob("*.tar.gz"))
    if not wheels or not sdists:
        raise RuntimeError(f"build did not produce a wheel + sdist in {out_dir}")
    return wheels[0], sdists[0]


def _extract_wheel(wheel_path: Path, dest: Path) -> None:
    with zipfile.ZipFile(wheel_path) as zf:
        zf.extractall(dest)


def _extract_sdist(sdist_path: Path, dest: Path) -> None:
    with tarfile.open(sdist_path, "r:gz") as tf:
        # data_filter (3.12+) sanitizes member paths; fall back for older interpreters. The archive
        # is one we just built ourselves, so this is a hygiene guard, not a trust boundary.
        extract_kwargs = {"filter": "data"} if hasattr(tarfile, "data_filter") else {}
        tf.extractall(dest, **extract_kwargs)  # type: ignore[arg-type]  # noqa: S202


def _decode(raw: bytes) -> str:
    return raw.decode("utf-8", errors="replace")


def _strip_python_comments(source: str) -> str:
    """Blank ``#`` comment bytes in Python source, leaving all other bytes (incl. docstrings and
    string-literal VALUES) intact — the artifact analog of the ``src/`` ast dimension's
    comment-exemption.

    Uses ``tokenize`` so classification is token-accurate: only ``COMMENT`` tokens are blanked; a
    ``#`` INSIDE a string literal (e.g. a URL value ``"http://…"``) is a ``STRING`` token and is
    preserved, so the scan is never blinded. Newlines are preserved so line numbers don't shift. If
    the source does not tokenize (a malformed payload), it is returned unchanged — scanning the raw
    bytes is the safe (never-under-scan) fallback.
    """
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return source
    lines = source.splitlines(keepends=True)
    for tok in tokens:
        if tok.type != tokenize.COMMENT:
            continue
        (srow, scol), (erow, ecol) = tok.start, tok.end
        if srow != erow:  # a comment is single-line by construction; guard anyway
            continue
        line = lines[srow - 1]
        lines[srow - 1] = line[:scol] + (" " * (ecol - scol)) + line[ecol:]
    return "".join(lines)


def _scan_extracted_tree(root: Path, artifact_label: str) -> list[Violation]:
    """Walk every file in one extracted artifact, classifying by role.

    - test-tooling ``.py`` (``test_*.py``/``*_test.py``/``conftest.py``): excluded from the
      payload-CONTENT scan (they legitimately name the tokens), but their PATHS are still name-scanned;
    - other ``.py``/``.pyi`` payload: content scanned, NO carve-out;
    - ``METADATA``/``PKG-INFO``: header fields NO carve-out + embedded description block WITH the doc
      carve-out;
    - every other file (``RECORD``, ``WHEEL``, swept-in ``.gitignore``/dotfiles, ``pyproject.toml``,
      ``README.md``): content scanned WITH the doc carve-out (they may legitimately carry an
      ``examples/quillstream`` path link — e.g. ``RECORD`` never does, but ``README.md`` swept into
      the sdist does);
    - every file PATH (relative, incl. dist + module names): name-scanned, NO carve-out, NO test
      exemption.
    """
    violations: list[Violation] = []
    for file in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = file.relative_to(root).as_posix()
        label = f"{artifact_label}:{rel}"

        # (path/name dimension) every path, no carve-out, no test exemption.
        for tok in _find_forbidden(rel):
            violations.append(
                Violation(dimension="artifact", file=label, detail=f'forbidden token "{tok}" in artifact path')
            )

        text = _decode(file.read_bytes())

        if file.suffix in _PAYLOAD_SUFFIXES:
            if _is_test_tooling_file(file):
                continue  # content excluded (path already scanned above)
            # Strip ``#`` comments before scanning: a ``# De-branded from posthog's …`` provenance
            # comment is AST-exempt in the ``src/`` dimension and PM-locked to MAY-reach-the-wheel
            # (Python ships source), so the artifact dimension must exempt it too — matching the
            # locked boundary exactly. Docstrings + string-literal VALUES + the identifier surface
            # stay in-scope (only ``#`` comment bytes are blanked); a ``posthog`` docstring or a
            # vendor name in the surface STILL fails.
            for tok in _find_forbidden(_strip_python_comments(text)):
                violations.append(
                    Violation(
                        dimension="artifact",
                        file=label,
                        detail=f'forbidden token "{tok}" in payload {file.suffix} (surface / literal value / docstring)',
                    )
                )
            continue

        if file.name in _DESCRIPTION_METADATA_NAMES:
            violations.extend(_scan_metadata_file(label, text))
            continue

        if file.name == "RECORD":
            violations.extend(_scan_record_file(label, text))
            continue

        # Remaining metadata / swept-in files (WHEEL, pyproject.toml, README.md, .gitignore).
        # Doc carve-out applies: these may carry a legit ``examples/quillstream`` path link.
        for tok in _find_forbidden_with_carveout(text):
            detail = (
                'forbidden token "quillstream" in artifact metadata prose (only a path link is allowed)'
                if tok.lower() == "quillstream"
                else f'forbidden token "{tok}" in artifact metadata'
            )
            violations.append(Violation(dimension="artifact", file=label, detail=detail))
    return violations


def _scan_metadata_file(label: str, text: str) -> list[Violation]:
    """Split ``METADATA``/``PKG-INFO``: header fields (NO carve-out) + embedded description (carve-out).

    The header ends at the first blank line; everything after is the embedded README long-description
    (``Description-Content-Type: text/markdown``). The header's structured fields (``Name:`` etc.)
    can never legitimately carry ``quillstream``, so they get NO carve-out; the description block IS
    embedded doc prose, so it gets the SAME carve-out the README doc dimension applies.
    """
    violations: list[Violation] = []
    parts = text.split("\n\n", 1)
    header = parts[0]
    description = parts[1] if len(parts) > 1 else ""

    for tok in _find_forbidden(header):
        violations.append(
            Violation(dimension="artifact", file=label, detail=f'forbidden token "{tok}" in packaging metadata field')
        )
    for tok in _find_forbidden_with_carveout(description):
        detail = (
            'forbidden token "quillstream" in metadata description prose (only a path link is allowed)'
            if tok.lower() == "quillstream"
            else f'forbidden token "{tok}" in packaging metadata description'
        )
        violations.append(Violation(dimension="artifact", file=label, detail=detail))
    return violations


def _scan_record_file(label: str, text: str) -> list[Violation]:
    """Scan the wheel ``RECORD`` — a ``path,sha256=…,size`` manifest — by its PATH column only.

    Each line is ``relative/path,sha256=<base64url>,<size>``. The base64url sha256 hashes are
    opaque bytes that carry no vendor semantics but WILL contain incidental substrings (a real hash
    embeds ``_ph_``), so scanning the raw line naive-``includes`` false-fails. The file-name
    dimension cares about the PATH column — the actual module/dist names a consumer observes — so we
    scan exactly that (comma-split field 0), NO carve-out, and skip the hash/size columns.
    """
    violations: list[Violation] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        record_path = line.split(",", 1)[0]
        for tok in _find_forbidden(record_path):
            violations.append(
                Violation(dimension="artifact", file=label, detail=f'forbidden token "{tok}" in RECORD path')
            )
    return violations


def scan_artifacts(repo_root: Path) -> list[Violation]:
    """Build, fully extract, and scan BOTH the wheel and the sdist. CI-only (needs a build)."""
    violations: list[Violation] = []
    with tempfile.TemporaryDirectory(prefix="neutrality-scan-") as tmp:
        tmp_path = Path(tmp)
        out_dir = tmp_path / "dist"
        out_dir.mkdir()
        wheel_path, sdist_path = _build_artifacts(repo_root, out_dir)

        wheel_root = tmp_path / "wheel"
        sdist_root = tmp_path / "sdist"
        _extract_wheel(wheel_path, wheel_root)
        _extract_sdist(sdist_path, sdist_root)

        violations.extend(_scan_extracted_tree(wheel_root, f"wheel[{wheel_path.name}]"))
        violations.extend(_scan_extracted_tree(sdist_root, f"sdist[{sdist_path.name}]"))
    return violations


# --- Entry points -------------------------------------------------------------------------------
def scan_fast(paths: RepoScanPaths) -> list[Violation]:
    """The cheap, every-commit pass: the ``src/`` ``ast`` wire-confinement + the doc dimension.

    No build — wired into the fast ``uv run pytest`` gate.
    """
    violations: list[Violation] = []
    violations.extend(scan_wire_confinement(paths.src_dir))
    violations.extend(scan_docs(paths))
    return violations


def scan_full(paths: RepoScanPaths) -> list[Violation]:
    """The full CI pass: ``scan_fast`` PLUS the wheel/sdist build-extract-scan.

    Needs a build (``uv build``), so it is CI-only — building the wheel per commit is too slow for
    the inner loop.
    """
    violations = scan_fast(paths)
    violations.extend(scan_artifacts(paths.repo_root))
    return violations


def format_violations(violations: list[Violation]) -> str:
    return "\n".join(f"  [{v.dimension}] {v.file}\n      {v.detail}" for v in violations)


def default_paths() -> RepoScanPaths:
    repo_root = Path(__file__).resolve().parent.parent
    return RepoScanPaths(
        repo_root=repo_root,
        src_dir=repo_root / "src" / "analytics_kit",
        readme_path=repo_root / "README.md",
        extra_doc_paths=[],
    )


def main(argv: list[str]) -> int:
    full = "--full" in argv
    paths = default_paths()
    violations = scan_full(paths) if full else scan_fast(paths)
    mode = "full (artifacts + src + doc)" if full else "fast (src + doc)"
    if violations:
        print(f"neutrality scan [{mode}] — {len(violations)} violation(s):", file=sys.stderr)
        print(format_violations(violations), file=sys.stderr)
        return 1
    print(f"neutrality scan [{mode}] — clean, 0 violations.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
