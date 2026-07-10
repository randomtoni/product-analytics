---
id: PY5-S1-query-protocol-specs-result-factory
epic: PY5-QRY-query-client
status: ready-for-dev
area: query
touches: [adapters]
depends_on: []
api_impact: additive
---

# PY5-S1-query-protocol-specs-result-factory — Query `Protocol` + specs + `QueryResult` + config + factory + no-op

## Why

Establishes the query read substrate: the neutral `AnalyticsQueryClient` `Protocol` (four business primitives + `raw_query`), the taxonomy-typed spec dataclasses, the single flat `QueryResult`, the separate query config (distinct key + endpoint), the config-selected factory, and the query no-op. This is the type contract both the HTTP adapter (PY5-S2) and the warehouse stub (PY5-S3) satisfy — the thing that makes bar A provable. It is the Python realization of TS `E8-S1` (query seam) + `E8-S2` (config + no-op), and it fills the empty PY1-skeleton `query.py` (as a `query/` submodule). It reads the PY2 seam + PY3 taxonomy; it does NOT touch the PY4 server-capture path (a SEPARATE server surface with its own key + endpoint).

## Scope

### In

- A `query/` submodule under `analytics_kit` (e.g. `query/client.py`) exporting `AnalyticsQueryClient` — a `typing.Protocol` (structural, matching the seam's Protocol convention) with exactly five members, each returning a `QueryResult` **synchronously** (NOT a coroutine — the sync-client posture):
  - `funnel(spec: FunnelSpec) -> QueryResult`
  - `retention(spec: RetentionSpec) -> QueryResult`
  - `trend(spec: TrendSpec) -> QueryResult`
  - `unique_count(spec: UniqueCountSpec) -> QueryResult`
  - `raw_query(expr: str) -> QueryResult` (the adapter-specific escape hatch)
- The four **spec dataclasses** — library-built OUTBOUND, so **plain `@dataclass`, NOT Pydantic**:
  - `FunnelSpec` — `steps: list[str]`, `within: Duration`, `breakdown: str | None = None`
  - `RetentionSpec` — `cohort_event: str`, `return_event: str`, `periods: int`, `granularity: Granularity`, `breakdown: str | None = None`
  - `TrendSpec` — `event: str`, `aggregation: Aggregation`, `window: Duration`, `breakdown: str | None = None`
  - `UniqueCountSpec` — `event: str`, `window: Duration`, `breakdown: str | None = None`
  - The neutral supporting value types the specs reference (role-named, no vendor/HogQL vocabulary): `Duration` (`@dataclass { value: int; unit: Literal["minute","hour","day","week","month"] }`), `Granularity = Literal["day","week","month"]`, `Aggregation = Literal["total","unique","dau"]`.
- The single flat **`QueryResult`** — a **Pydantic model** (this is the one genuine INBOUND-wire boundary, the exception to "specs are plain dataclasses"; see Technical notes): `rows: list[dict[str, object]]`, `columns: list[QueryColumn]`, `generated_at: str`, `from_cache: bool | None = None`; with `QueryColumn` = `{ name: str; type: str | None = None }` (a Pydantic model). One flat result serves all four primitives + raw_query (no bespoke per-primitive result types).
- A **separate `QueryClientConfig`** — a **Pydantic** model DISTINCT from the ingest `AnalyticsConfig` (the Python analog of the TS `QueryClientConfig` vs ingest split): `query_endpoint: str | None`, `personal_key: str | None` (a server personal/read key, Bearer auth — DISTINCT from the ingest write `key`), `project_id: str | None`, `taxonomy: Taxonomy | None`, plus the injectable transport hook (see PY5-S2). None of its fields alias the ingest config. It carries the **same `model_config` posture as `AnalyticsConfig`**: `ConfigDict(extra="forbid", arbitrary_types_allowed=True)` — `extra="forbid"` so a config typo raises loudly (not silent-degrades), and `arbitrary_types_allowed=True` because `taxonomy: Taxonomy | None` is held opaque via the same `isinstance(value, Taxonomy)` posture the ingest config uses (a raw dict fails at this boundary, not later).
- A `create_query_client(config)` factory + a `QueryNoop` null object: keyed+endpointed ⇒ builds the HTTP adapter (PY5-S2 fills this branch; S1 wires the seam + selection); unkeyed ⇒ `QueryNoop` (an `AnalyticsQueryClient` returning an empty `QueryResult` — bar B).

### Out

- The HTTP adapter implementation (spec→wire, POST, poll, normalize) — **PY5-S2** (S1 wires the factory branch as a stub/fill-in).
- The warehouse stub — **PY5-S3**.
- Any wire vocabulary (query kinds, the wire query language, endpoint path, auth header) — adapter-internal, `_WIRE_*`-confined, PY5-S2.
- Bespoke per-primitive result types — deliberately not built; one flat `QueryResult` serves all.
- The ingest/capture surface (PY4) — a SEPARATE server surface; PY5 shares only the seam + taxonomy.

## Acceptance criteria

- [ ] `AnalyticsQueryClient` is a `Protocol` with exactly `funnel`/`retention`/`trend`/`unique_count`/`raw_query`, each returning `QueryResult` synchronously (no coroutine); a structural-conformance test proves an adapter satisfies it without subclassing — via the shipped **`_conforms(client: AnalyticsQueryClient) -> None` type-level sink pattern** (mypy proves satisfaction on a plain-`object` assignment, no `isinstance`), mirroring PY4-S1's `test_server_adapter_conforms_to_spi_structurally` / `_conforms` in `tests/test_server_adapter.py`. This same sink is what S2/S3 reuse for the bar-A proof.
- [ ] The four spec types are plain `@dataclass` (NOT Pydantic); `QueryResult` + `QueryColumn` are Pydantic models; the value types (`Duration`/`Granularity`/`Aggregation`) name no vendor/HogQL concept.
- [ ] `QueryResult` carries `rows` (list of dict, cell values `object`/untyped — a snapshot job casts), `columns` (a distinct ordered list — an empty result still carries its schema), `generated_at`, `from_cache: bool | None` (optional — the wire flag is conditionally present).
- [ ] `QueryClientConfig` is DISTINCT from `AnalyticsConfig` — `personal_key`/`query_endpoint`/`project_id` do NOT alias the ingest `key`/ingest endpoint; it carries `ConfigDict(extra="forbid", arbitrary_types_allowed=True)` (a config typo raises; a raw-dict `taxonomy` fails at this boundary).
- [ ] `create_query_client(unkeyed config)` returns a `QueryNoop` whose primitives return an empty `QueryResult` (bar B); keyed+endpointed wires the HTTP adapter branch (PY5-S2 fills the body).
- [ ] `raw_query(expr: str)` returns `QueryResult` (NOT untyped) — the escape hatch is for the query LANGUAGE, never the result CONTRACT.
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token in the query surface / specs / result / config / docstrings; `grep -ri posthog` over `query/` clean (source-level).

## Technical notes

- **CONTRACT reference (port TO):** `ts/packages/node/src/query/{query-client,config}.ts` + the seam `ts/packages/analytics-kit/src/query-result.ts`. The exact shapes: `QueryResult { rows: ReadonlyArray<Record<string,unknown>>; columns: ReadonlyArray<QueryColumn>; generatedAt; fromCache? }`, `QueryColumn { name; type? }`, the taxonomy-typed specs, and the separate `QueryClientConfig { queryEndpoint; personalKey; projectId; taxonomy; fetch }`. **posthog-python is a WEAK reference** (its query surface is thin) — the query primitives + flat result + taxonomy-typing are the TS lib's OWN surface; de-brand only the HogQL-over-HTTP wire idiom (PY5-S2), NOT the neutral surface.
- **Specs plain dataclass (outbound), `QueryResult` Pydantic (inbound boundary).** — architect (2026-07-09, Cluster 2): the specs are library-built outbound → trusted-by-construction → plain `@dataclass`. `QueryResult` decodes external untrusted wire JSON → this is THE one genuine inbound-wire boundary in the query path → Pydantic-validate. This is the deliberate exception to "specs are plain": the boundary is the result, not the spec.
- **Business primitives only — the highest-neutrality-risk surface.** No query-dialect vocabulary (the de-branded analog of `HogQLQuery`/`kind`/`InsightVizNode` — the exact token class that LEAKED into `dist` in R1, HISTORY.md) may appear on `AnalyticsQueryClient`/the specs/`QueryResult`. `raw_query(expr: str)` is the ONLY place a dialect surfaces, and it surfaces as a VALUE (the string), not a type — exactly like a DB driver's `.query(sql)`. PY8's neutrality scan asserts this; PY5 is the highest-risk epic for the `HogQLQuery`-leak class.
- **Flat `QueryResult` for all (TS `E8-S1`, architect):** one flat result serves all four primitives + raw_query. Retention survives flat as tidy rows (one row per `(cohort, period)` cell) — already relational, exactly what a snapshot job INSERTs. `rows` cell values are untyped (`object`) — adapter/engine-reported, snapshot casts. `columns` is its own ordered list (empty result still carries schema). `from_cache` optional (the wire flag is only present on cached responses — read defensively in PY5-S2).
- **Separate query config (TS `E8-S2`):** `QueryClientConfig` is server-only and DISTINCT from ingest — a server personal/read key against a query endpoint, never aliasing the ingest write key/endpoint. Mirror the TS split (they are distinct Pydantic models, not one merged config). Personal-key handling is server-side only.
- **Taxonomy-typing of specs — best-effort static, the honest gap (PY3-S3).** The specs reference event names (`steps`/`event`/`cohort_event`/`return_event`). Type them via the SAME best-effort-static pattern PY3-S3 settled — a consumer-authored `Literal` event-name union statically + the PY3 runtime registry — NOT hand-written overloads or a mypy plugin. State the honest gap (runtime-registry parity + best-effort static, NOT TS compile-time parity — no const generics). Do NOT over-promise compile-time safety on the specs; `steps: list[str]`/`event: str` at the type level, with the typed-view convenience layered per PY3-S3.
- **Conformance-test pattern (bar-A substrate — pin it in S1, S2/S3 inherit it).** Use the shipped `_conforms`-style TYPE-LEVEL sink, NOT `@runtime_checkable` + `isinstance`: a `def _conforms(client: AnalyticsQueryClient) -> None: ...` that an adapter instance is passed to, so mypy proves structural satisfaction without subclassing (the exact `_conforms(adapter: AnalyticsAdapter)` shape shipped in `tests/test_server_adapter.py`). `AnalyticsQueryClient` need NOT be `@runtime_checkable` for the bar-A proof — the proof is type-level (mypy), the runtime test is just a collection anchor. This is the seam both S2's `HttpQueryAdapter` and S3's `WarehouseQueryAdapter` are checked against unchanged.
- **Module fence:** the query machinery lives in the new `query/` submodule (reading the PY2 seam + PY3 taxonomy). It does NOT touch the PY4 server-capture modules (a separate surface). Do not import the PY4 adapter/consumer here. The `test_sync_seam.py` no-threading/no-asyncio fence targets TOP-LEVEL seam modules only (`provider`/`config`/`factory`/`noop`/`adapter`/`client` resolved as `<pkg>/<name>.py`), so the `query/` submodule is OUTSIDE that fence — but the query surface is sync by its own posture regardless (no coroutine on any member; S2's poll is a blocking `time.sleep`, never asyncio).
- **Neutrality lesson — docstrings ship** vendor-neutral; wire vocab (none on this neutral surface) is confined in PY5-S2.

## Shipped

> Captured by `implement-epics` on 2026-07-10.

- **Files added:** `python/src/analytics_kit/query/{__init__,client,config,factory,noop}.py`, `tests/test_query_client.py`
- **Files removed:** `python/src/analytics_kit/query.py` (empty PY1 placeholder → `query/` package; `import analytics_kit.query` still resolves)
- **Files changed:** `__init__.py` (query surface exports)
- **New public API:** `AnalyticsQueryClient` (Protocol, 5 sync members → `QueryResult`), `FunnelSpec`/`RetentionSpec`/`TrendSpec`/`UniqueCountSpec` (plain `@dataclass`), `Duration`/`Granularity`/`Aggregation`, `QueryResult`/`QueryColumn` (Pydantic, matching TS `query-result.ts`), `QueryTransport` (`@runtime_checkable` — for the Pydantic isinstance-guard), `QueryClientConfig` (separate Pydantic, `extra="forbid"`), `create_query_client`, `QueryNoop`
- **Tests added:** the `_conforms(AnalyticsQueryClient)` type-level sink (the bar-A substrate S2/S3 inherit), spec/result Pydantic split, config distinctness, bar-B no-op, neutrality (no dialect on `__all__`)
- **Commit:** `core-cycle` (message = story title)
- **Reviewer notes:** clean — the `_conforms` sink **negative-controlled 3 ways** (drop a member / `async def` / wrong return → all fail at the type-level sink; the sync posture is genuinely type-enforced); neutrality graded independently (`posthog`+`hogql`/warehouse-dialect grep clean — the only `hogql`/`kind` hits are prohibition docstrings); `QueryResult` matches TS byte-for-byte; the `@runtime_checkable`-only-on-`QueryTransport` split is sound (config needs the runtime isinstance-guard; the bar-A proof is type-level).
- **Cross-story seams exposed:** **S2** fills `query/factory.py::_build_http_query_client` (currently `NotImplementedError`) with `HttpQueryAdapter` reading `config.query_endpoint`/`personal_key`/`project_id`/`transport`; the injectable `QueryTransport.send(url, method, headers, body: str|None) -> NeutralResponse` (str-bodied — no gzip wrinkle) is on `QueryClientConfig.transport` (S2 supplies the stdlib default); ALL `_WIRE_*` vocab confined to `query/http_adapter.py`; poll is a blocking `time.sleep` loop. **S3** reuses the `_conforms` sink verbatim (bar-A proof) and must match the SYNC `def` signatures (an `async def` fails the sink).
