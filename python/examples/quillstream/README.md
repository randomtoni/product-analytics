# Quillstream — the bar-B example consumer

Quillstream is an invented, server-shaped SaaS that adopts `analytics-kit` **by configuration
alone**. It supplies every product specific — its taxonomy, config, allowlist contents, the
recording test double, a query exercise, and the framework wiring — and reaches the library through
its **public API only**, with **zero edits to `analytics_kit`**. That is bar B: *new-app adoption =
config only, zero library change.*

It is a SEPARATE `uv` project depending on the parent via an editable `[tool.uv.sources]` dep, so it
type-checks against the INSTALLED distribution's public types (resolved via `py.typed`), never a
`../../src` source-tree reroute.

## The two-gate bar-B proof

TypeScript enforces bar B by **physical absence**: the published `dist` exposes only re-exports, so
`tsc` literally cannot resolve a library internal. **Python has no such boundary** — an editable or
wheel install exposes the whole import tree, and `py.typed` / `__all__` / mypy do NOT block a deep
import. So the architect ruled the Python bar-B gate **splits into two, and neither alone suffices**:

1. **Fidelity gate — installed-dist mypy.** `uv run mypy .` type-checks the entire example against
   the INSTALLED `analytics-kit` public types (via the editable dep + `py.typed`), with zero
   `analytics_kit` edits. A clean run proves the example type-checks against the installed
   distribution — the analog of TS Fernly's `turbo typecheck`-against-`dist`.

2. **Enforcement gate — the AST import-audit** (`tests/test_bar_b_import_audit.py`). It `ast.parse`s
   every example `*.py`, walks the `import` / `from … import …` nodes, and asserts every
   `analytics_kit`-rooted import resolves to the **public** surface — the top-level namespace or one
   of the curated public subpackages (`integrations` / `query` / `server` / `taxonomy`) — failing
   any deeper module, any `_WIRE_*`, or any `_`-prefixed name.

**Why both.** mypy resolves `import analytics_kit.provider` just as happily as a public import, so
the fidelity gate cannot catch an internal reach; `__all__` does not block a deep import, the
internals cannot be excluded from the wheel (the public factories need them at runtime), and Python
has no `exports` map — so nothing but the AST audit can enforce public-API-only. Neither gate
subsumes the other; **do not simplify this back to a single gate** — dropping either silently deletes
half the proof.

## Running the gates

Both gates run in **this example directory** (a SEPARATE invocation from the main `python/` suite,
whose `[tool.mypy] files` / `testpaths` deliberately exclude `examples/**`):

```
cd python/examples/quillstream
uv run mypy .     # fidelity gate — installed-dist public types, zero library edits
uv run pytest     # the exercise + the AST enforcement gate
```

Both exit 0 ⇒ the bar-B proof holds.
