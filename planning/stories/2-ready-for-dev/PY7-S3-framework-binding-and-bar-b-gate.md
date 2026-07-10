---
id: PY7-S3-framework-binding-and-bar-b-gate
epic: PY7-CORE-example-consumer
status: ready-for-dev
area: core
touches: [react]
depends_on: [PY7-S1-example-project-taxonomy-config, PY7-S2-capture-query-allowlist-exercise]
api_impact: additive
---

# PY7-S3-framework-binding-and-bar-b-gate — Framework-binding exercise + the two-gate bar-B proof

## Why

Closes the epic: exercises the framework binding (PY6 — a request-scoped distinct_id carried through the middleware) and stands up **the bar-B proof itself** — the two gates the architect ruled are together the Python analog of TS Fernly's typecheck-against-dist: a **fidelity gate** (mypy against the installed distribution's public types) + an **enforcement gate** (an AST import-audit asserting the example imports ONLY the public API, no internals). It is the Python realization of TS `E10-S8` (React wiring) + the bar-B/bar-A proof that closes E10.

## Scope

### In

- **Framework-binding exercise:** drive the PY6 middleware (Django or ASGI/FastAPI) through the framework's own IN-MEMORY test client (`[django]`/`[fastapi]` dev-deps of the example project) — send a request, the middleware opens a `new_context()`, the handler `capture(...)`s through the context-scoped view against the SAME recording adapter from PY7-S1, and the assertion is that the capture carried the request-bound distinct_id + tags. No bound socket (the framework test clients are in-process request simulators).
- **The bar-B fidelity gate:** `uv run mypy` in the example project type-checks the whole example (taxonomy + config + recording adapter + the capture/query/framework exercise) against the INSTALLED `analytics-kit` public types (via the editable dep + `py.typed`), with ZERO `analytics_kit` edits. A clean run IS the bar-B proof of config-only adoption.
- **The bar-B enforcement gate:** an **AST import-audit test** (in the example project) that `ast.parse`s every example `*.py` and asserts every `analytics_kit` import resolves to a PUBLIC namespace only:
  - allowed: `import analytics_kit` / `from analytics_kit import <name in __all__>`, and the curated public SUBPACKAGES `analytics_kit.integrations` / `analytics_kit.query` / `analytics_kit.server` (each has its own `__all__`);
  - FAIL: any deeper import (`analytics_kit.provider`, `analytics_kit.server.wire_mapper`, `analytics_kit.query.http_adapter`), any `_WIRE_*`, any `_`-prefixed name.
  AST, not grep (multi-line/aliased imports; the codebase already pins structural guarantees with real parsing).

### Out

- Any `analytics_kit` edit — `examples/**` only (bar B). If the example can't type-check against the public surface without a library edit, that's a SEAM BUG to surface (per the architect check — none was found), NOT an example patch.
- The capture/query/allowlist exercise (PY7-S2 — this story adds the framework binding + the gates over the whole example).
- A real backend / bound socket.

## Acceptance criteria

- [ ] A request through the framework test client (Django or ASGI/FastAPI) carries a request-bound distinct_id + tags into a `capture(...)` recorded on the shared recording adapter — asserted in-memory, no socket.
- [ ] **Fidelity gate:** `uv run mypy` (strict) in the example project passes, resolving the INSTALLED `analytics-kit` public types via `py.typed`, with ZERO `analytics_kit` edits.
- [ ] **Enforcement gate:** the AST import-audit test passes — every example `analytics_kit` import is to a public namespace (top-level or a curated public subpackage); a deep/internal import or a `_`-prefixed import FAILS the test. (Add a negative-control: a deliberately-internal import in a test fixture is detected as a violation.)
- [ ] The full example gate suite (`uv run mypy` + `uv run pytest`) exits 0; the changeset touches only `python/examples/**` (bar B, verifiable by diff).
- [ ] The two gates together constitute the documented bar-B proof (a module/README note states: fidelity = installed-dist mypy, enforcement = AST import-audit — Python needs both because it has no physical `dist` boundary).

## Technical notes

- **#4 ARCHITECT RULING (2026-07-10) — the TWO-GATE model (the load-bearing mechanic):** the TS bar-B gate is enforced by PHYSICAL ABSENCE (`dist` only has re-exports, so `tsc` can't resolve internals). Python has NO such boundary — an editable/wheel install exposes the whole import tree, and `py.typed`/`__all__`/mypy do NOT block a deep import. So the Python bar-B gate SPLITS into two, and neither alone suffices:
  1. **Fidelity gate** — mypy in the separate example project resolving the installed `analytics-kit` public types (via `py.typed`), zero library edits → proves "type-checks against the installed distribution."
  2. **Enforcement gate** — the AST import-audit → proves "public API only, no internals reached." mypy/`__all__`/packaging each PROVABLY cannot enforce this alone (mypy resolves `import analytics_kit.provider` happily; the internals can't be excluded from the wheel because the public factories need them at runtime; there's no Python `exports`-map). Say this explicitly so nobody later "simplifies" it back to a single gate and silently deletes enforcement.
- **The AST audit MUST allowlist the curated public subpackages** (`analytics_kit.integrations` — the middleware's honest public import point — plus `analytics_kit.query`/`analytics_kit.server` if the example imports them), or it false-positives on a legitimate public import. Forbid everything BELOW them + any `_`-prefixed name. Encode the allowlist explicitly.
- **Framework injection (architect (c)):** the Django test client / Starlette `TestClient` are in-process; the middleware wraps a context-aware provider backed by the PY7-S1 recording adapter, so a request-driven capture records in-memory with no network. This re-drives PY6's own middleware tests at the CONSUMER layer.
- **No seam defect (architect confirmed):** every capability the example needs is reachable from the public `analytics_kit` namespace (`create_analytics`, `AnalyticsAdapter`, `NeutralEvent`, the query surface incl. `QueryTransport`/`QueryClientConfig`/`create_query_client`, the taxonomy surface, the server factory) + the public `analytics_kit.integrations` middleware. The example implements `AnalyticsAdapter`/`QueryTransport` purely from re-exported public types — zero `analytics_kit` edit. If a future finding contradicts this, it's a seam bug to surface, not an example patch.
- **CONTRACT reference (port TO):** `ts/examples/fernly/src/{bar-b-config-only.test.ts, bar-a-adapter-swap.test.ts, app/*}` — the bar-B on-disk structural assertion (Fernly's no-`paths`-reroute check is the analog of the "no `../../src` reroute" + the import-audit), the framework wiring, config-only adoption. Server-shaped (no browser/JSX component tree — the middleware is the server analog of the React provider).
- **Neutrality:** `examples/**` exempt from the scan; the two gates enforce public-API-only + config-only.

## Shipped

<!-- Captured by implement-epics on close. -->
