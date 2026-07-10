---
id: PY7-CORE-example-consumer
status: planned
area: core
touches: [node, query, react]
api_impact: additive
blocked_by: [PY4-NODE-server-capture, PY5-QRY-query-client, PY6-RCT-framework-bindings]
updated: 2026-07-09
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

_Tentative slice (story files not yet written):_

- **S1** — the example's taxonomy + config: invented product's events/traits/groups, allowlist, identity mapping, ingest + query config — all consumer-supplied, no library edit.
- **S2** — the capture + query exercise: server capture across the taxonomy (typed + gated), a query-client snapshot returning the expected flat shape, an allowlist-rejection demonstration.
- **S3** — the framework-binding exercise (Django or FastAPI middleware carrying a request-scoped distinct_id) + the mypy-against-installed-distribution gate that IS the bar-B proof.

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
