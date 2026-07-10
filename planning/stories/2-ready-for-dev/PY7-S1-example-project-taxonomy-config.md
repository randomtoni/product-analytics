---
id: PY7-S1-example-project-taxonomy-config
epic: PY7-CORE-example-consumer
status: ready-for-dev
area: core
touches: [node]
depends_on: []
api_impact: additive
---

# PY7-S1-example-project-taxonomy-config — Example project scaffold + taxonomy + config + recording adapter

## Why

Every PY7 slice adopts through one shared harness: an invented server-shaped product under `python/examples/<product>/`, wired to an in-memory recording `AnalyticsAdapter`. This story stands up that harness — a SEPARATE uv project (the Fernly-workspace-member analog), its `define_taxonomy(...)`, its config, and the recording adapter — so the rest of the epic just adds the capability exercise + the bar-B gate on top. This IS the bar-B substrate: a new app adopted by config alone, running against a mock, never a real backend. It is the Python realization of TS `E10-S1` (Fernly scaffold + recording adapter) + `E10-S2` (taxonomy).

## Scope

### In

- `python/examples/<invented-product>/` as a **SEPARATE uv project** (the architect ruling — see Technical notes): its OWN `pyproject.toml` (`private`/no-publish; distribution/import name is the invented product), depending on `analytics-kit` via `[tool.uv.sources]` (editable/workspace: `analytics-kit = { path = "../..", editable = true }` OR `{ workspace = true }` if a root workspace is introduced), with its OWN `[tool.mypy] strict = true` + `[dependency-groups] dev` (pytest + the `[django]`/`[fastapi]` extras it needs for S3). It runs its OWN `uv run mypy` / `uv run pytest`. **No `pythonpath`/`mypy_path` pointing at `../../src`** (that would silently degrade the gate to a source-tree typecheck — see Technical notes).
- The invented product's **taxonomy**: a concrete `define_taxonomy({...})` (events + traits + groups + props) authored via the PUBLIC `analytics_kit` API only — the product supplies ALL specifics; the library ships zero event names.
- The product's **config**: the ingest `AnalyticsConfig` (key, super_properties, allowlist contents, on_violation, taxonomy) + the `QueryClientConfig` (personal key + query endpoint) — all consumer-supplied.
- A **`RecordingAdapter`** implementing the shipped `AnalyticsAdapter` Protocol IN FULL (structural — it satisfies the Protocol or mypy fails). The Protocol's EIGHT members (read the real shape in `adapter.py`): `capture(event: NeutralEvent) -> None` (buffers into an inspectable `list[NeutralEvent]`), `flush() -> None`, `shutdown() -> None`, `send(url, method, headers, body=None) -> NeutralResponse` (returns a canned `NeutralResponse(status=200, body="")`), `get_consent_state() -> ConsentState` (returns `"granted"` — see the consent footgun below), `set_consent_state(state) -> None`, `get_library_id() -> str`, and `get_library_version() -> str` (the real name is `get_library_version`, NOT `version`). This is the injection point for `create_analytics(config, adapter)`.
- A small harness factory (`create_<product>_analytics(...)`) that adopts through the PUBLIC `create_analytics(config, adapter=...)`. **Two branches, and the unkeyed one must NOT inject the recorder** (see Technical notes — this is a real footgun in the factory contract): keyed ⇒ `create_analytics(config, adapter=recording_adapter)` (the recorder); unkeyed ⇒ `create_analytics(config)` with NO adapter argument, so the seam's own default — the shipped `NoopAdapter` — applies (whole-stack no-op, bar B). `create_analytics` uses whatever adapter is supplied AS-IS regardless of `config.key`; it is NOT a key-driven recorder-vs-noop switch, so the harness owns the branch by choosing whether to pass an adapter at all (mirroring TS E10-S1).

### Out

- The capture + query exercise + allowlist-rejection + unkeyed-noop assertions — **PY7-S2**.
- The framework-binding exercise + the two-gate bar-B proof (mypy-against-installed-dist + AST import-audit) — **PY7-S3**.
- Any edit under `analytics_kit` — the example is `examples/**` only (bar B). If the example needs a library edit to work, that's a SEAM BUG to surface (per the epic + the architect check), NOT an example patch.
- A real backend endpoint/key.

## Acceptance criteria

- [ ] `python/examples/<product>/` is a SEPARATE uv project with its own `pyproject.toml` depending on `analytics-kit` via `[tool.uv.sources]` editable/workspace; `uv sync` resolves it.
- [ ] The example's `[tool.mypy]` is strict and does NOT reroute to `../../src` (no `pythonpath`/`mypy_path` to the source tree — it resolves the INSTALLED `analytics-kit` public types via `py.typed`).
- [ ] The product's `define_taxonomy(...)` + config are authored via the PUBLIC `analytics_kit` API only (no internal import).
- [ ] `RecordingAdapter` satisfies the `AnalyticsAdapter` Protocol in full (all eight members, mypy-enforced) with zero `analytics_kit` edits; every capture records into an inspectable `list[NeutralEvent]`; `get_consent_state()` returns `"granted"`. A positive "records something" assertion (capture N events ⇒ the recorder's list has N) exists — NOT only an empty-stream check (guards against the vacuous-pass footgun below).
- [ ] The harness factory adopts via `create_analytics(config, adapter=...)`: keyed ⇒ `create_analytics(config, adapter=recording_adapter)` (recorder); unkeyed ⇒ `create_analytics(config)` with NO adapter (seam-default `NoopAdapter`). The unkeyed branch does NOT pass the recorder.
- [ ] The changeset touches only `python/examples/**` (+ a root workspace file if the workspace shape is chosen) — nothing under `analytics_kit` (bar B, verifiable by diff).
- [ ] `uv run mypy` + `uv run pytest` in the example project exit 0.
- [ ] The invented product name appears ONLY under `examples/` (it may freely name itself — `examples/**` is exempt from the neutrality scan; see Technical notes).

## Technical notes

- **#4 ARCHITECT RULING (2026-07-10, dedicated consult, HIGH confidence) — the bar-B gate mechanism:**
  - **(a) SEPARATE uv project** at `python/examples/<product>/`, its own `pyproject.toml` + `[tool.mypy] strict` + own `uv run mypy`, depending on the parent via `[tool.uv.sources]` editable/workspace dep. This is the faithful Fernly port (Fernly is a separate workspace member with its own typecheck-against-`dist`). An **editable install gives sufficient "installed distribution" fidelity** — mypy sees the installed `analytics_kit` public types via `py.typed`, NOT a `src/`-tree reroute. **Rejected Option B** (a subdir folded into the parent's `files=["src","tests","examples"]`): it type-checks against the SOURCE tree, dropping the entire bar-B value, and makes an internal import look identical to a public one. **Critical:** the example's mypy must NOT set `pythonpath=["../../src"]` — that silently degrades (a) into (b).
  - The one honest gap vs TS: an editable install still exposes internals as importable (`analytics_kit.provider`, `_WIRE_*`) — Python has NO physical `dist`-boundary. That is what the PY7-S3 AST import-audit gate exists to close; no install mode closes it. (See PY7-S3.)
- **Concrete example `pyproject.toml` shape (pin, from reading the real parent `python/pyproject.toml`).** The parent is `name = "analytics-kit"`, `requires-python = ">=3.10"`, hatchling build with `packages = ["src/analytics_kit"]`, `[project.optional-dependencies]` `django`/`fastapi`, and dev tooling in `[dependency-groups] dev` (pytest/ruff/mypy/django/starlette/httpx). The example project mirrors that shape:
  - `[project]` — the invented product name, `requires-python = ">=3.10"`, `dependencies = ["analytics-kit"]` (the extras it needs: `"analytics-kit[django]"` and/or `"analytics-kit[fastapi]"` for the S3 framework exercise).
  - `[tool.uv.sources]` — `analytics-kit = { path = "../..", editable = true }` (the parent `python/` dir is two levels up from `python/examples/<product>/`). If a root uv workspace is introduced instead, `{ workspace = true }`; either satisfies the editable-fidelity requirement. `uv sync` in the example dir resolves it.
  - `[dependency-groups] dev` — `pytest`, plus the framework test deps S3 needs: `django` (WSGI middleware is a plain callable — no extra harness) and `starlette` + `httpx` (the ASGI path drives a real Starlette app over `httpx.ASGITransport`, matching the PY6 precedent — Starlette's own `TestClient` is deprecated).
  - `[tool.mypy]` — `strict = true`, `python_version = "3.10"`. **NO `files`/`mypy_path`/`pythonpath` pointing at `../../src`** — `uv run mypy .` resolves the INSTALLED `analytics_kit` public types via `py.typed`.
- **Run-invocation (pin — the real orchestration wrinkle).** The example is a SEPARATE uv project; the parent `python/pyproject.toml`'s `[tool.mypy] files = ["src", "tests"]` and `[tool.pytest.ini_options] testpaths = ["tests"]` DELIBERATELY exclude `examples/**`, so the main `python/` gates never see the example (correct — that keeps the fidelity gate honest). The example's gates run as a SEPARATE invocation the orchestrator calls in the example dir: `cd python/examples/<product> && uv run mypy .` (fidelity gate) + `uv run pytest` (the exercise + the AST audit). Document these two commands in the story's Shipped/README note so the orchestrator + reviewer know exactly how to verify — the main suite does NOT shell out to them; they are a distinct gate step.
- **Unkeyed-branch footgun (pin).** `create_analytics(config, adapter=None)` uses the supplied adapter AS-IS; when `adapter is None` it falls back to the seam-default `NoopAdapter` (read `factory.py`: `resolved = adapter if adapter is not None else NoopAdapter()`). It is NOT a key-driven recorder-vs-noop switch. So the unkeyed no-op branch MUST call `create_analytics(config)` (no adapter) — if the harness injects the recorder unconditionally, an unkeyed config STILL routes through the recorder and the S2 "unkeyed records nothing" assertion becomes untestable. (`create_server_analytics(config)` is the alternative unkeyed path — it also defers to the seam-default `NoopAdapter` when `config.key is None` — but the recording harness wants the plain `create_analytics(config)` since it never wants the real `ServerAdapter`/socket.)
- **CONTRACT reference (port TO):** `ts/examples/fernly/` — the separate-workspace-member shape, the `RecordingAdapter` (`recording-adapter.ts`), the config-only adoption, the bar-B typecheck-against-dist gate. **posthog-python is a WEAK reference** (its `example.py` is a flat script, not a bar-B-proving separate consumer) — the bar-B gate is the TS lib's OWN concept; port the Fernly gate, de-brand nothing.
- **RecordingAdapter = the injection point** (architect (c)): the example's capture path injects a recording `AnalyticsAdapter` into `create_analytics(config, adapter=recording_adapter)` (the shipped factory uses a supplied adapter as-is). `AnalyticsAdapter` is a structural `Protocol`, so the recorder implements `capture`/`flush`/`shutdown`/`send`/`get_consent_state`/`set_consent_state`/`get_library_id`/`get_library_version` and buffers instead of delivering — never a socket.
- **Consent-default footgun (carry from TS E10-S1):** the provider suppresses sends when opted-out; the recorder's `get_consent_state()` must return a GRANTING state (`"granted"`) so captures land on the recorder, else stream assertions pass vacuously. Pin this in S1, hold across S2/S3. Two nuances from reading the real code: (1) the provider's opt-out gate is its OWN in-memory `_opted_out` flag (`opt_out()`/`opt_in()`/`has_opted_out()`), initialized `False` — so a default-construction provider is NOT opted out; the recorder's granting consent is belt-and-suspenders parity (the PY6 recording adapters in `test_asgi_middleware.py`/`test_django_middleware.py` set `self._consent = "granted"` — copy that exact posture). (2) Because vacuous-empty is the failure mode, S1 MUST include a POSITIVE assertion (capture ⇒ recorder list is non-empty with the expected event), not just an empty-stream check — pin it in the AC.
- **Neutrality:** `examples/**` is EXEMPT from the neutrality scan (TS convention: `examples/**` exempt — carried to PY8, which must exempt `python/examples/**`). The example may freely name its own invented product, but it must use ONLY the neutral public `analytics_kit` API (no `_WIRE_*` / internal reach) — the PY7-S3 AST audit enforces that.

## Shipped

<!-- Captured by implement-epics on close. -->
