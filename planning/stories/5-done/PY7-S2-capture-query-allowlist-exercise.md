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

- **Server-capture exercise:** through the PY7-S1 harness (`create_analytics(config, adapter=recording_adapter)`), `capture(distinct_id, "event", {...})` / `set(distinct_id, traits)` / `set_group_traits(group_type, group_key, traits)` across the invented product's taxonomy, asserting on-list props reach the recording adapter's stream. Note the real seam split (read `provider.py`): the allowlist gate (`_allowed`) runs on ALL THREE verbs, but the taxonomy PROP-TYPE validator (`validate_event_props`) runs ONLY on `capture` (the event name selects the prop shape — `set`/`set_group_traits` trait shapes are not name-selected, so they are allowlist-gated but NOT prop-type-validated). Assert allowlist enforcement on all three; assert taxonomy prop-type validation only on `capture`. Also note the exact minted shapes for the assertion: `set(...)` mints event name `"set_traits"` with `internal_kind="set_traits"` and properties `{"set": traits}` (or `{"set_once": traits}` when `once=True`); `set_group_traits(...)` mints `"set_group_traits"` with `internal_kind="set_group_traits"` and a `{group_type, group_key, group_set}` bag — the recording adapter records these as `NeutralEvent`s and the assertion inspects `.event`/`.internal_kind`/`.properties`.
- **Query exercise:** `create_query_client(QueryClientConfig(personal_key=..., query_endpoint=..., transport=FakeQueryTransport()))` with a fake `QueryTransport` returning a canned wire body that decodes into a `QueryResult`; run `funnel(...)`/`retention(...)`/`trend(...)`/`unique_count(...)` and assert each returns the flat `QueryResult` shape a snapshot job expects (`rows`/`columns`/`generated_at`/`from_cache`). **Both `personal_key` AND `query_endpoint` MUST be set** — the factory (`create_query_client` in `query/factory.py`) returns the silent `QueryNoop` when EITHER is absent, so an endpointless config yields a no-op and the `QueryResult`-shape assertions pass vacuously (the query analog of the consent footgun). The fake transport is injected via `QueryClientConfig.transport`; its `send(...)` returns a `NeutralResponse(status=200, body=<canned JSON>)` whose body decodes into `QueryResult`. No socket.
- **Allowlist loud-failure assertion:** a deliberate off-list PII key (e.g. `ssn`) triggers a loud failure under the default `throw` policy — a `pytest.raises(ValueError, match=r'property "ssn" is not on the payload allowlist')` proving enforcement (the exact message the seam raises — see `allowlist.py`). Route the off-list key so it's a RUNTIME allowlist violation, not a compile error that blocks the test: call `capture(...)` on the UNTYPED provider view (the shipped `Analytics.capture` runtime signature is `properties: dict[str, object] | None`, which admits arbitrary keys), NOT through a consumer-authored `cast(TypedAnalytics, ...)` typed view (see Technical notes for the compile-vs-runtime routing). A companion `on_violation="drop-and-error-log"` branch: the off-list event is dropped (recorder clean) + a single error is logged.
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
- [ ] A deliberate off-list PII key (routed through the untyped provider `capture`, per Technical notes) triggers a loud failure under default `throw` (`pytest.raises(ValueError, match=r'property "ssn" is not on the payload allowlist')`); under `on_violation="drop-and-error-log"` the off-list event is dropped (recorder stream clean) + a single error logged (assert via `caplog`); on-list keys still record under BOTH policies (the CONTRACT's regression pin — switching to drop must not gate on-list keys).
- [ ] The unkeyed harness records nothing on `capture` (bar-B whole-stack no-op).
- [ ] The changeset touches only `python/examples/**` — nothing under `analytics_kit` (bar B, verifiable by diff). If a capability appears missing, it's a bar-B FAILURE → file a bug against the owning epic (PY4/PY5), do NOT patch `analytics_kit`.
- [ ] `uv run mypy` + `uv run pytest` in the example project exit 0.

## Technical notes

- **Injection points (architect (c), all shipped, all constructor-injected — no socket):**
  - Capture → the PY7-S1 recording `AnalyticsAdapter` via `create_analytics(config, adapter)`.
  - Query → a fake `QueryTransport` via `QueryClientConfig.transport`, then `create_query_client(config)`; its `send(...)` returns a canned `NeutralResponse` whose JSON body decodes into a `QueryResult`. **Selection requires BOTH `personal_key` AND `query_endpoint`** (read `query/factory.py`: `if config.personal_key is None or config.query_endpoint is None: return QueryNoop()`) — an endpointless or keyless config yields the silent `QueryNoop` whose primitives return an EMPTY `QueryResult`, so the shape assertions would pass vacuously. Set both so the HTTP adapter branch is selected and the fake transport is actually exercised, returning a populated `QueryResult`.
- **Allowlist loud-failure — compile-vs-runtime routing (the Python analog of TS E10-S5, but the routing DIFFERS — read this).** The guard (`enforce_allowlist` in `allowlist.py`) gates property KEYS (not event names, not values), raising `ValueError` on the first off-list key under `throw`. The provider wires it into `capture`/`set`/`set_group_traits` via `_allowed(...)` BEFORE any mint. **The Python routing is NOT the TS `register` routing:** TS routes `ssn` through `register` because `track`/`identify` are compile-checked; but Python's server provider has **NO `register` runtime verb** — `register` is N-A server-side (construction-time `super_properties` only, see `provider.py`'s Frozen-15 table). Instead, Python's compile-vs-runtime split is: the shipped `Analytics.capture` runtime signature is already loose (`properties: dict[str, object] | None` = `NeutralProperties | None`), so an off-list `ssn` key is NOT a mypy error on the plain provider — it is directly a RUNTIME allowlist `ValueError`. Static tightening happens ONLY if the consumer applies their OWN `cast(TypedAnalytics, create_analytics(...))` typed view (per the taxonomy recipe in `taxonomy.py`), which is a `cast` no-op that mypy checks. **Pin the exact path:** route the off-list demonstration through the UNTYPED provider (`analytics.capture("some_event", {"ssn": "..."})` where `analytics` is the plain `Analytics` return of `create_analytics`, NOT a `cast`-narrowed view) so `pytest.raises(ValueError, ...)` fires at runtime while the whole example still type-checks under strict mypy. (Do NOT route the off-list key through a `cast`-typed view — that WOULD be a mypy error and break the fidelity gate.) The taxonomy-typed static-safety demonstration is a SEPARATE, positive concern (show that a `cast`-typed view catches a bad event name / wrong-typed prop at compile time) — keep it distinct from the runtime-allowlist demonstration; don't conflate them into one call.
- **Consent-default (carry from PY7-S1):** the recorder returns a granting consent state, so captures land on the recorder — else the stream assertions pass vacuously.
- **CONTRACT reference (port TO):** `ts/examples/fernly/src/{allowlist-loud-failure.test.ts, server/*, kpi/*}` — the loud-failure crux + compile-vs-runtime pin, the node-capture exercise, the KPI-snapshot query test with a mock transport. Server-shaped (no browser merge/cross-subdomain journey — N-A).
- **Bar-B diff invariant:** `examples/**` only. A missing capability is a bar-B failure to surface against the owning epic, NOT an example-side `analytics_kit` patch.
- **Neutrality:** `examples/**` exempt from the neutrality scan; public API only (PY7-S3 audits the imports).

## Shipped

> Captured by `implement-epics` on 2026-07-10.

- **Files added (all under `python/examples/quillstream/`):** `src/quillstream/typed_view.py` (the PY3-S3 `Protocol`+`cast` recipe demo) + `tests/{test_server_capture,test_query_exercise,test_allowlist_loud_failure,test_unkeyed_noop,test_typed_view_static_safety}.py`
- **Files changed:** none under `analytics_kit` (bar B — zero library edits)
- **Exercise:** server capture across the taxonomy (3 verbs; allowlist on all 3, `validate_event_props` only on `capture`; minted `set_traits`/`set_group_traits` shapes asserted on the recorder); query via a fake `QueryTransport` (both `personal_key`+`query_endpoint` → real HTTP branch, `transport.calls==1`) → flat `QueryResult`; allowlist loud-failure; unkeyed no-op
- **⚠ Gate step:** `cd python/examples/quillstream && uv run mypy . && uv run pytest` — mypy clean (12 files), pytest 24 passed
- **Commit:** `core-cycle` (message = story title)
- **Reviewer notes:** clean — the allowlist runtime-not-compile routing **proven from both sides** (untyped `Analytics.capture` route → runtime `ValueError` with NO `type: ignore`, full example strict-clean; a `cast`-view negative-control probe → mypy `[call-overload]`); both policies covered (`throw` raises pre-mint / `drop-and-error-log` drops + logs once); on-list keys record under BOTH policies (regression pin); query footgun pinned (endpointless config → empty, `transport.calls==[]`). The `analytics_kit.taxonomy` import is the **documented PY3-S3 recipe re-export** (`Protocol`/`TypedDict`/`cast`) — legitimate public API.
- **Cross-story seams exposed:** **S3** (the two-gate proof) — the AST import-audit's public-API allow-list MUST include **`analytics_kit.taxonomy`** (the recipe's documented public import point for the typing helpers), i.e. `{analytics_kit, .integrations, .query, .server, .taxonomy}`; else it would fail `typed_view.py`'s legitimate recipe import. `overload`/`Literal` correctly come from `typing` (ruff can't follow those through a re-export). Carried to PY8 (the public-API surface definition).
