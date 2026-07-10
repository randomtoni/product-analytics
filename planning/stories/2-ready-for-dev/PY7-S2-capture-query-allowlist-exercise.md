---
id: PY7-S2-capture-query-allowlist-exercise
epic: PY7-CORE-example-consumer
status: ready-for-dev
area: core
touches: [node, query]
depends_on: [PY7-S1-example-project-taxonomy-config]
api_impact: additive
---

# PY7-S2-capture-query-allowlist-exercise — Capture + query exercise, allowlist loud-failure, unkeyed no-op

## Why

Exercises the two data surfaces the example must prove — server capture (PY4) and the query client (PY5) — plus the two bar-B/privacy proofs: an off-list key fails LOUDLY (E3 privacy contract as an executable consumer proof) and the unkeyed path is a silent whole-stack no-op. All via the PUBLIC API, against injected fakes, never a real backend. It is the Python realization of TS `E10-S5` (allowlist loud-failure) + `E10-S6` (node capture) + `E10-S7` (KPI query).

## Scope

### In

- **Server-capture exercise:** through the PY7-S1 harness (`create_analytics(config, recording_adapter)`), `capture("event", {...})` / `set(...)` / `set_group_traits(...)` across the invented product's taxonomy — taxonomy-typed + allowlist-enforced — asserting on-list props reach the recording adapter's stream.
- **Query exercise:** `create_query_client(QueryClientConfig(..., transport=FakeQueryTransport()))` with a fake `QueryTransport` returning a canned wire body that decodes into a `QueryResult`; run `funnel(...)`/`retention(...)`/`trend(...)`/`unique_count(...)` and assert each returns the flat `QueryResult` shape a snapshot job expects (`rows`/`columns`/`generated_at`/`from_cache`). No socket.
- **Allowlist loud-failure assertion:** a deliberate off-list PII key (e.g. `ssn`) triggers a loud failure under the default `throw` policy — an `pytest.raises(...)` proving enforcement. Route the off-list key through a path whose bag admits arbitrary keys so it's a RUNTIME allowlist violation, not a compile error that blocks the test (see Technical notes for the compile-vs-runtime routing — the Python analog of TS E10-S5's `register` routing). A companion `on_violation="drop-and-error-log"` branch: the off-list event is dropped (recorder clean) + logged.
- **Unkeyed no-op assertion:** the unkeyed harness (no `key`) records nothing on `capture` — a silent whole-stack no-op (bar B), proving an unconfigured environment sends nothing.
- All assertions run under `uv run pytest` in the example project, against the recording adapter / fake query transport — never a network.

### Out

- The framework-binding exercise + the two-gate bar-B proof (mypy-against-installed-dist + AST import-audit) — **PY7-S3**.
- Re-testing the allowlist / capture / query mechanism internals (PY3/PY4/PY5 own that) — here it's a consumer-side executable demonstration.
- Any `analytics_kit` edit — `examples/**` only (bar B).
- A real backend / real socket.

## Acceptance criteria

- [ ] Server capture across the taxonomy records on-list props onto the recording adapter's stream (taxonomy-typed + allowlist-enforced); asserted in-memory.
- [ ] The query client (with the fake transport) returns a flat `QueryResult` (`rows`/`columns`/`generated_at`/`from_cache`) for funnel/retention/trend/unique_count — the shape a snapshot job expects; no socket.
- [ ] A deliberate off-list PII key triggers a loud failure under default `throw` (`pytest.raises`); under `on_violation="drop-and-error-log"` the off-list event is dropped (recorder clean) + logged; on-list keys still pass.
- [ ] The unkeyed harness records nothing on `capture` (bar-B whole-stack no-op).
- [ ] The changeset touches only `python/examples/**` — nothing under `analytics_kit` (bar B, verifiable by diff). If a capability appears missing, it's a bar-B FAILURE → file a bug against the owning epic (PY4/PY5), do NOT patch `analytics_kit`.
- [ ] `uv run mypy` + `uv run pytest` in the example project exit 0.

## Technical notes

- **Injection points (architect (c), all shipped, all constructor-injected — no socket):**
  - Capture → the PY7-S1 recording `AnalyticsAdapter` via `create_analytics(config, adapter)`.
  - Query → a fake `QueryTransport` via `QueryClientConfig.transport`, then `create_query_client(config)`; its `send(...)` returns a canned `NeutralResponse` whose JSON body decodes into a `QueryResult`. (Unkeyed config yields `QueryNoop`, but to prove the query capability is shaped right, inject the fake so a real `QueryResult` comes back.)
- **Allowlist loud-failure — compile-vs-runtime routing (the Python analog of TS E10-S5).** The guard gates property KEYS (not event names, not values), throwing on the first off-list key. If the props are taxonomy-typed, an undeclared key like `ssn` is a mypy error BEFORE it can be a runtime violation — which would block the test from type-checking. To exercise the RUNTIME guard, route the off-list key through a path whose bag admits arbitrary keys (the Python analog of TS routing through `register` / an explicit cast) — e.g. a `capture` with a props bag typed `dict[str, object]` (not the taxonomy-typed view), or the super_properties path. Pick the path that makes `pytest.raises` fire at runtime while the example still type-checks. Pin the exact path in the story so the builder doesn't hit a compile wall.
- **Consent-default (carry from PY7-S1):** the recorder returns a granting consent state, so captures land on the recorder — else the stream assertions pass vacuously.
- **CONTRACT reference (port TO):** `ts/examples/fernly/src/{allowlist-loud-failure.test.ts, server/*, kpi/*}` — the loud-failure crux + compile-vs-runtime pin, the node-capture exercise, the KPI-snapshot query test with a mock transport. Server-shaped (no browser merge/cross-subdomain journey — N-A).
- **Bar-B diff invariant:** `examples/**` only. A missing capability is a bar-B failure to surface against the owning epic, NOT an example-side `analytics_kit` patch.
- **Neutrality:** `examples/**` exempt from the neutrality scan; public API only (PY7-S3 audits the imports).

## Shipped

<!-- Captured by implement-epics on close. -->
