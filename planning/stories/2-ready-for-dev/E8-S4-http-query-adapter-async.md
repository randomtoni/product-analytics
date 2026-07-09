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

- Extend the S3 HTTP query adapter to detect and handle the async response mode: when the POST returns `{ query_status: { id, complete, ... } }` instead of an inline result envelope, poll the status endpoint until `complete` (or a bounded attempt/timeout budget), then fetch/normalize the final result.
- A bounded, backoff-aware poll loop (reuse the retry/backoff posture E5 established where sensible — exponential-ish with a cap; a configurable max attempts / max wait, with a safe give-up that surfaces as a neutral error, not a hang).
- Normalize the eventual completed result into the **same** `QueryResult` shape as the sync path — a caller cannot tell sync from async from the return value.
- Unit tests against an injected mock `fetch` that returns an async `{ query_status }` envelope first, then a completed result on a subsequent poll — asserting the loop polls, terminates on `complete`, and returns a normalized `QueryResult`. Also a give-up test (never-completes ⇒ bounded termination, neutral error). Never hits a real backend.

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
- **Poll mechanics need the query-schema doc.** The exact status-endpoint path, the poll/refresh request shape, and the completed-result retrieval are part of the same PostHog query-schema doc pull S3 flagged — consult `posthog-source-guide` / the schema doc for the async `/query/` status + refresh mechanics. Med-confidence until pulled. — epic Development prerequisites.
- **Reuse existing backoff posture.** E5 (`packages/browser`) already ships exponential-backoff-with-jitter for transport retries; borrow the *shape* of that bounded loop rather than inventing a new one, but keep it adapter-local (no cross-package coupling — copy the small helper if needed, de-duplication is not this story's job).
- **Give-up surfaces neutrally.** On timeout/exhaustion, reject/return a neutral error — never leak the `query_status` envelope or a vendor identifier. A snapshot job should see "query did not complete", not a vendor object.
- **Builds directly on S3.** This extends the same `HttpQueryAdapter`; it depends on S3's sync normalization + transport being in place (`depends_on: [E8-S3]`).

## Shipped
