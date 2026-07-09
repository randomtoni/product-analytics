---
id: E8-S4-http-query-adapter-async
epic: E8-QRY-query-client
status: ready-for-dev
area: query
touches: [adapters, node]
depends_on: [E8-S3-http-query-adapter-sync]
api_impact: additive
---

# E8-S4-http-query-adapter-async — HTTP query adapter: async refresh/poll path

## Why

Long-running queries return an async status envelope instead of results inline; the adapter must poll it to completion and still return the same neutral `QueryResult`. This makes the HTTP adapter robust for real funnel/retention snapshots over large windows — the async path stays entirely adapter-internal, never surfacing on the interface.

## Scope

### In

- Extend the S3 HTTP query adapter to detect and handle the async response mode: when the POST returns `{ query_status: { id, complete: false, ... } }` (equivalently HTTP 202) instead of an inline result envelope, poll the status endpoint until `complete === true` (or a bounded attempt/timeout budget), then normalize the final result.
  - **Async is adapter-opted-in, not backend-decided.** PostHog runs async when the POST body carries a `refresh` param (`'async'` / `'force_async'` / `'lazy_async'` / `'async_except_on_cache_miss'`). The adapter chooses when to request async (e.g. always, or for the long-window primitives); it is not that the backend spontaneously returns async for a plain POST. Pin the adapter's async-request posture in a Technical note. (Confirmed posthog-source-guide 2026-07-08.)
  - **Detection keys on `body.query_status.complete === false`** (or HTTP 202), NOT merely on "a `query_status` key is present" — the same envelope key carries the completed result too (see below).
- **Poll is a GET, and the completed result nests one level deeper than the sync path.** Poll `GET {queryEndpoint}/api/projects/{projectId}/query/{query_status.id}/` (a GET, not a re-POST). The poll response keeps the SAME `{ query_status: {...} }` envelope; when `complete` flips true, the results land at **`query_status.results`** (an `Any`) — and do NOT carry sibling `columns`/`types`/`hogql` at the `query_status` level (those live inside the stored result object). So S4 cannot reuse S3's top-level sync-envelope reader verbatim: factor S3's normalization to accept "the result-bearing object" so both the sync top-level envelope AND the async `query_status.results` object feed the same `QueryResult` builder. (Confirmed posthog-source-guide 2026-07-08.)
- A bounded, backoff-aware poll loop (reuse the retry/backoff posture E5 established where sensible — exponential-ish with a cap; a configurable max attempts / max wait, with a safe give-up that surfaces as a neutral error, not a hang).
- Normalize the eventual completed result into the **same** `QueryResult` shape as the sync path — a caller cannot tell sync from async from the return value.
- Unit tests against an injected mock `fetch` that returns an async `{ query_status: { complete: false } }` envelope first (on the POST), then a `GET` poll that flips to `{ query_status: { complete: true, results, ... } }` — asserting the loop polls via GET, terminates on `complete`, reads the nested `query_status.results`, and returns a normalized `QueryResult`. Also a give-up test (never-completes ⇒ bounded termination, neutral error). Never hits a real backend.

### Out

- Any change to the neutral interface or `QueryResult` — the async path is purely adapter-internal.
- The warehouse stub — S5.
- Streaming / websocket query modes — out of scope; poll-to-completion is the R1 async story.

## Acceptance criteria

- [ ] When the initial POST returns an async `{ query_status: { id, complete } }` envelope, the adapter polls to completion and returns a normalized `QueryResult` identical in shape to the sync path — proven with a mock `fetch` that flips from pending → complete across calls.
- [ ] The poll loop is bounded (max attempts / max wait) and never hangs; an async query that never completes terminates with a neutral error (no vendor envelope leak in the error), asserted by a test.
- [ ] Sync and async are indistinguishable to the caller: the same `funnel/retention/trend/uniqueCount/rawQuery` call returns the same `QueryResult` type regardless of which mode the backend used.
- [ ] No `query_status` / vendor async-envelope field appears in any exported type or in the returned value. Typecheck + lint + test + build green.

## Technical notes

- **Adapter-internal async wire [WIRE].** Async mode returns `{ query_status: { id, complete } }` to poll; both the sync envelope and the async refresh/poll path are handled adapter-internally and never surface on the interface. All normalized to a neutral `QueryResult` before it reaches the consumer. — architect (2026-07-07, epic Notes)
- **Poll mechanics — RESOLVED (posthog-source-guide 2026-07-08, grounded in `PostHog/posthog:posthog/schema.py` + `posthog/api/query.py` @ HEAD).** No longer med-confidence:
  - **Trigger**: send a `refresh` param in the POST body (async values `'async'` / `'force_async'` / `'lazy_async'` / `'async_except_on_cache_miss'`). Adapter opts in; the backend does not spontaneously go async.
  - **Pending envelope**: `QueryStatusResponse` = `{ query_status: QueryStatus }` where `QueryStatus` has `id` (required), `complete` (bool, defaults false), `error`/`error_message`, `results` (`Any`, populated on completion), plus `query_async: true`, timing fields, `query_progress`.
  - **Poll**: `GET /api/projects/{projectId}/query/{id}/` (the `id` is `query_status.id`). GET, not re-POST. `DELETE` on the same URL cancels (out of R1 scope).
  - **Completion**: `query_status.complete === true`; results at `query_status.results`; failure surfaces as `query_status.error` / `error_message`.
- **Async result nests deeper than sync — factor S3's normalizer, don't fork it.** S3 normalizes the top-level sync envelope (`{ results, columns, types, is_cached }`); the async-complete payload nests the result inside `query_status.results` and omits the sibling `columns`/`types` at that level. Extend S3's adapter by extracting its "envelope → `QueryResult`" step into a small helper that takes the result-bearing object, then feed it either the sync top-level envelope or the async `query_status.results`. This is the "extends, not forks" composition with S3 (`depends_on: [E8-S3]`). — refinement (2026-07-08)
- **Reuse existing backoff posture.** E5 (`packages/browser`) already ships exponential-backoff-with-jitter for transport retries; borrow the *shape* of that bounded loop rather than inventing a new one, but keep it adapter-local (no cross-package coupling — copy the small helper if needed, de-duplication is not this story's job).
- **This is a POLL loop, not a transport retry — the two node precedents differ, and that is intentional.** Node's shipped capture transport (`packages/node/src/send-batch.ts:24-26`) deliberately uses FIXED-delay retry (not exponential), with a comment that the browser's exponential+jitter is a browser concern node need not match. Do NOT read that as "node must poll with fixed delay too": query polling is a distinct concern (waiting for a long-running query to finish, not retrying a failed send), and exponential-ish-with-cap polling is the right shape there (short first waits, backing off as the query runs longer). The apparent contradiction between the two node precedents is resolved by: transport-retry = fixed (send-batch), query-poll = exponential-ish-with-cap (this story). Keep the poll helper adapter-local. — refinement (2026-07-08)
- **Give-up surfaces neutrally.** On timeout/exhaustion, reject/return a neutral error — never leak the `query_status` envelope or a vendor identifier. A snapshot job should see "query did not complete", not a vendor object.
- **Builds directly on S3.** This extends the same `HttpQueryAdapter`; it depends on S3's sync normalization + transport being in place (`depends_on: [E8-S3]`).

## Shipped
