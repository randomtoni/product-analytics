---
id: PY7-CORE-example-consumer
status: done
area: core
touches: [node, query, react]
api_impact: additive
blocked_by: [PY4-NODE-server-capture, PY5-QRY-query-client, PY6-RCT-framework-bindings]
updated: 2026-07-10
---

# PY7-CORE-example-consumer — Generic Python example consumer (bar B proof)

## Why

The example consumer is the executable proof of **bar B — new-app adoption = config only, zero library change**. It is the Python realization of TS `E10-CORE-example-consumer` (Fernly): one invented product supplying its own taxonomy, identity mapping, allowlist, KPI definitions, and framework wiring, exercising every Python surface with **zero `analytics_kit` package changes**. Server-shaped — no browser journey to simulate. Informed by the BRIEF §Deliverables and the TS-E10 precedent.

## Success criteria

- A generic example consumer (an invented product, no real product name/domain) lives under a `python/examples/` location, supplying ALL product specifics: a concrete taxonomy (events + traits + groups + props), identity mapping, allowlist contents, KPI/snapshot definitions, and framework wiring — **zero edits to `analytics_kit`**.
- It exercises **every Python surface**: server capture (PY4) with the taxonomy typed + allowlist enforced, the query client (PY5) returning the shape a snapshot job expects, and a framework binding (PY6) carrying a request-scoped distinct_id.
- It type-checks **against the built/installed distribution** (the mypy-clean example IS the bar-B proof, the analog of TS Fernly's `turbo typecheck`-against-`dist` gate) — importing `analytics-kit` as a consumer would, not reaching into internals.
- The allowlist rejects a disallowed key **loudly** in the example (proving enforcement), and the unkeyed path is a silent no-op (proving bar B's no-op posture).
- Zero vendor references and zero product logic leak into `analytics_kit` — the example holds all product specifics; the library holds only primitives.

## Stories

Chain — `S1 → S2 → S3`; topo-sortable via `depends_on`. Written to `stories/2-ready-for-dev/`. **The bar-B gate is architect-locked as a TWO-gate model** (Python has no physical `dist` boundary like TS): a fidelity gate (mypy against the installed distribution) + an enforcement gate (an AST import-audit for public-API-only). No seam defect surfaced — the example needs zero `analytics_kit` edits.

- **[PY7-S1](../stories/5-done/PY7-S1-example-project-taxonomy-config.md)** *(done — `6ca792c`)* — a SEPARATE uv project at `python/examples/quillstream/` (own `pyproject.toml` + `[tool.mypy] strict` + editable `[tool.uv.sources]` dep on `analytics-kit`) + the invented product's `define_taxonomy(...)` + config + a full-Protocol recording `AnalyticsAdapter` (granting consent); harness adopts via `create_analytics(config, adapter)` (keyed ⇒ recorder, unkeyed ⇒ `NoopAdapter`).
- **[PY7-S2](../stories/5-done/PY7-S2-capture-query-allowlist-exercise.md)** *(done — `7d15a15`)* — server-capture exercise across the taxonomy (typed + gated) + query exercise via a fake `QueryTransport` returning a flat `QueryResult` + the allowlist off-list-key loud-failure (compile-vs-runtime routing) + drop-and-error-log branch + unkeyed whole-stack no-op. All in-memory, no socket.
- **[PY7-S3](../stories/5-done/PY7-S3-framework-binding-and-bar-b-gate.md)** *(done — `ed37522`)* — framework-binding exercise (ASGI/Starlette over `httpx.ASGITransport` in `anyio.run`, carrying a request-scoped distinct_id + tag into a recorded capture) + **the two-gate bar-B proof**: fidelity (installed-dist mypy, zero library edits) + enforcement (AST import-audit — public namespaces only via the five-entry allow-list `{analytics_kit, .integrations, .query, .server, .taxonomy}`, no internals/`_WIRE_*`/`_`-prefixed).

Build topo order: `PY7-S1 → PY7-S2 → PY7-S3` — **all shipped**. The bar-B proof is realized as the architect-locked two-gate model; no seam defect surfaced (zero `analytics_kit` edits across all three stories; the `REQUEST_TAGS` config addition is genuine consumer config-only adoption through the allowlist gate).

**Location map** (`python/examples/<invented-product>/` — a SEPARATE uv project, NOT under the main `analytics_kit`; `examples/**` is neutrality-scan-exempt):

- the example's `pyproject.toml` (editable dep on `analytics-kit`, own strict mypy, `[django]`/`[fastapi]` dev-deps) + `define_taxonomy` + config module + the recording `AnalyticsAdapter` (S1)
- the capture + query exercise + allowlist + unkeyed-no-op tests (S2)
- the framework-binding exercise + the fidelity (installed-dist mypy) + enforcement (AST import-audit) gates (S3)

## Out of scope

- A real product integration — the first real consumer integrates in its own repo; this ships only a generic example (BRIEF).
- A browser/cross-subdomain journey — N-A server-side; the example is server-shaped.
- Any change to `analytics_kit` to make the example work — if the example needs a library change, that's a seam bug, not example scope (the whole point of bar B).

## Notes

- **Bar-B proof mechanics.** — PM (2026-07-09), from TS-E10: the example is a real consumer that imports the built/installed distribution and type-checks clean against it — that gate IS bar B. It supplies every product specific via config/taxonomy; the library ships zero product names. Mirror Fernly's posture, server-shaped.
- **Server-shaped exercise.** No anon→identified merge, no cross-subdomain cookie journey (browser-only, N-A). The example exercises server capture + query + a framework binding — the full Python surface.
- **Depends on the three capability epics.** `blocked_by: [PY4, PY5, PY6]` — the example can't exercise a surface that doesn't exist yet. PY5 (query) is parallel to PY4, but the example needs all three landed.

## Expansion path

A second example (or a second framework wiring) is additive under `examples/` — no library change, reinforcing bar B.
