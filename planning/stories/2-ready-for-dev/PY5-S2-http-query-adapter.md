---
id: PY5-S2-http-query-adapter
epic: PY5-QRY-query-client
status: ready-for-dev
area: query
touches: [adapters, node]
depends_on: [PY5-S1-query-protocol-specs-result-factory]
api_impact: additive
---

# PY5-S2-http-query-adapter — HTTP query adapter: sync-blocking-poll, Pydantic-decode, wire-confined

## Why

The first real query backend: maps each neutral primitive (and `raw_query`) to the adapter-internal query wire, POSTs with Bearer personal-key auth, and — as a **synchronous blocking poll** — resolves the response (immediate or async-status) into a Pydantic-decoded neutral `QueryResult`. This is what makes `create_query_client` actually query, and — with PY5-S3's stub — proves bar A. It is the Python realization of TS `E8-S3` (sync path) + `E8-S4` (async poll), collapsed into one sync-blocking-poll method (the sync-client ruling).

## Scope

### In

- An HTTP query adapter module in `query/` (e.g. `query/http_adapter.py`), named **by role** (`HttpQueryAdapter` / `create_http_query_adapter` — never a vendor name), satisfying `AnalyticsQueryClient`.
- Per-method translation (all adapter-internal, `_WIRE_*`-confined, never surfaced): `funnel`/`retention`/`trend`/`unique_count` → the matching kind-discriminated query body; `raw_query(expr)` → the raw-query-shaped body carrying `expr`. Send the inner query object directly (NOT wrapped in a UI presentation container). The exact per-method body-field mapping mirrors TS `E8-S3` (which grounded it in the PostHog query schema).
- Transport: `POST {query_endpoint}/<adapter-internal query path with project_id segment>` with headers `Authorization: Bearer <personal_key>` + `Content-Type: application/json`, using an **injectable transport on the adapter CONSTRUCTOR** (the same ruling as PY4-S3 — typed against a minimal adapter-owned transport Protocol; the query body is a JSON string so it fits a `str`-bodied transport, and the adapter reads `.status` + parses the response body). Defaults to a stdlib/`requests`-style impl.
- **Sync-blocking-poll** (the key Python shaping — see Technical notes): POST the query; if the response is the immediate result envelope, normalize and return; if it is the async status variant (`query_status`-style, not yet complete), **block with `time.sleep` between polls** (bounded budget) until complete, then normalize. NO asyncio — one synchronous method that blocks until the result is ready.
- **Normalize the wire envelope → neutral `QueryResult` via Pydantic** (the inbound boundary): map the wire `results` → `rows` (keyed by `columns`), `columns`/`types` → `QueryColumn[]`, the wire cache flag → `from_cache` **read defensively** (present only on cached responses — leave unset/`None` when absent), set `generated_at`. The vendor envelope never escapes the adapter.
- **fetch-failure normalization at the query transport boundary** (the same R1 lesson as PY4): a transport failure / non-OK status is normalized — a raw HTTP/vendor exception NEVER leaks onto the neutral surface (a non-OK response raises a neutral error or is handled; a raised transport exception is caught at the boundary). Vendor error-body shapes do not leak.
- Wire `create_query_client`'s keyed+endpointed branch (the PY5-S1 fill-in) to construct this adapter.
- Unit tests against an **injected mock transport** returning canned envelopes (immediate + async-status-then-complete), asserting: correct URL/method/auth header, correct kind body per primitive, sync-poll loop resolves the async variant, and correct envelope→`QueryResult` normalization. Never hits a real backend.

### Out

- The `Protocol` / specs / `QueryResult` / config / factory / no-op (PY5-S1).
- The warehouse stub (PY5-S3).
- Growing the neutral interface — anything the four primitives don't cover stays behind `raw_query`.
- Live end-to-end validation against a real query endpoint — gated on a real personal key (a Development prerequisite, not a `blocked_by`); unit tests use a mock transport.

## Acceptance criteria

- [ ] Each primitive POSTs to the config `query_endpoint` with `Authorization: Bearer <personal_key>` and the correct kind-discriminated body; asserted via an injected mock transport (no real network).
- [ ] The wire envelope is normalized to `QueryResult` via Pydantic (`rows` keyed by column, `columns` ordered, `from_cache` from the wire flag read defensively, `generated_at` set) — the raw vendor envelope shape appears NOWHERE in the returned value or any exported type.
- [ ] **Sync-blocking-poll:** an async-status response (not-yet-complete) is polled with blocking `time.sleep` (bounded budget) until complete, then normalized; the method is synchronous (no coroutine, no `await`). An immediate-result response returns without polling.
- [ ] `raw_query(expr)` delivers the raw string through the same POST path and returns the same normalized `QueryResult` — no separate result contract.
- [ ] **fetch-failure normalization:** a non-OK status / a raised transport exception is normalized at the boundary — no raw HTTP/vendor exception or error-body shape reaches the neutral surface (named negative-control test).
- [ ] No query-dialect vocabulary (the `HogQLQuery`/`kind`/`InsightVizNode` de-branded analog), endpoint path, or auth header appears in any EXPORTED type or on the `AnalyticsQueryClient` surface — all wire vocabulary is `_WIRE_*`-confined adapter-internal.
- [ ] Bar A holds: this adapter and the PY5-S3 warehouse stub both satisfy `AnalyticsQueryClient` with zero interface change. `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0; `grep -ri posthog` over `query/` clean.

## Technical notes

- **CONTRACT reference (port TO):** `ts/packages/node/src/query/{http-query-adapter,http-query-adapter-async}.ts` — the sync envelope normalization (`E8-S3`) + the async poll (`E8-S4`), collapsed here into ONE sync-blocking-poll method. The wire shapes (kind bodies, `results`/`columns`/`types` envelope, the cache flag conditionally present, the `/query/` path with a project-id segment, Bearer auth) are pinned in TS `E8-S3`'s notes (grounded in the PostHog query schema). **DE-BRAND FROM (wire idiom only):** the HogQL-over-HTTP wire — NOT the neutral surface. **Not a port of posthog-python** — posthog-python has no query client; this is built against the HTTP Query API.
- **Sync-blocking-poll — the key Python shaping.** — architect (2026-07-09, Cluster 2): the TS always-async HTTP poll (`http-query-adapter.ts`/`-async.ts`) becomes a SYNC BLOCKING poll in Python (the query client shares the port's sync posture — PY2-S4). One synchronous method: POST; if immediate-result, normalize+return; if async-status, loop with blocking `time.sleep` (bounded budget) until complete, then normalize. NO asyncio. The TS `setTimeout`-driven async poll → a `time.sleep`-driven blocking loop.
- **Injectable transport on the CONSTRUCTOR** (same ruling as PY4-S3, architect 2026-07-10): the query body is a JSON STRING (fits a `str`-bodied transport — no gzip-bytes wrinkle here), and the adapter must READ the response body (parse JSON), so the injectable transport is typed against a minimal adapter-owned Protocol that returns `{status, body}` (the adapter reads `.status` and parses `body`). Constructor injection (for a first-party proxy / custom session), NOT the seam `send` — consumer wiring flows through `create_query_client(config)`. The injected transport is typed against the adapter's own Protocol, never a vendor/library type.
- **`QueryResult` decode via Pydantic (the inbound boundary):** the wire response JSON is external untrusted → Pydantic-validate into `QueryResult` (PY5-S1's model). This is where PY5's Pydantic-at-the-boundary ruling lands. Read the cache flag defensively (present only on cached responses).
- **fetch-failure normalization (R1 lesson, same as PY4-S4):** a non-OK response raises a NEUTRAL error (no vendor error-body leak); a raised transport exception (connection/timeout) is caught at the boundary and normalized — never propagates raw onto the neutral surface. A named negative-control test asserts a raising/erroring transport does not leak.
- **Wire vocab `_WIRE_*`-confined — the highest-risk epic (PY8 asserts).** The de-branded query-dialect tokens (the `HogQLQuery`/`kind`/`InsightVizNode` analog — the exact `HogQLQuery` token that leaked into `dist` in R1, HISTORY.md), the endpoint path, query kinds, and the auth header all live in `_WIRE_*` module-level constants inside the adapter, NEVER on the neutral surface or in any exported type. This is the leak class PY8's scan is built to catch.
- **Name by role:** `HttpQueryAdapter`, never a vendor name — an internal adapter module named by role.
- **Neutrality lesson — docstrings ship** vendor-neutral; wire vocab `_WIRE_*`-confined.

## Shipped

<!-- Captured by implement-epics on close. -->
