---
id: E11-S3-bar-a-adapter-swap-audit
epic: E11-CORE-adoption-audit
status: ready-for-dev
area: core
touches: [observability]
depends_on: []
api_impact: additive
---

# E11-S3-bar-a-adapter-swap-audit — Bar A: provider-swap = one adapter, zero consumer change

## Why

Bar A — provider-swap = ONE adapter, ZERO consumer-code change — is half the release's acceptance test. It needs a durable proof, not a one-time inspection: an on-paper second-adapter design confirming one-adapter-fill-in-the-blanks, PAIRED with a concrete, re-runnable swap that changes the backend with zero consumer edits.

## Scope

### In

- **The concrete swap (gated):** a re-runnable assertion that swapping the backend adapter changes ZERO consumer code. Grounded in the E10 Fernly harness, which already selects `NoopAdapter` vs `RecordingAdapter` by config (`config.key === undefined ? NoopAdapter : RecordingAdapter`) through the SAME `createAnalytics(config, adapter, deps)` seam — the consumer facade is byte-identical across the swap. The story makes this a stated, checked bar-A demonstration (the swap surface exists; this asserts + documents it as the bar-A proof).
- **The on-paper second-adapter design:** a short written design of a hypothetical second client adapter satisfying the `AnalyticsAdapter` SPI, confirming a new backend is genuinely fill-in-the-blanks (one adapter, nothing else changes). Reference the already-shipped `WarehouseQueryAdapter` typed stub as the concrete precedent that a second adapter drops in behind the seam unchanged (two adapters, one interface, seam untouched).
- A writeup (in the audit doc / README section) tying the two together: the SPI surface a new adapter fills, and the demonstrated zero-consumer-change swap.

### Out

- Building a real second production adapter (self-hosted / another vendor) — additive future work, not this release.
- The query-side bar-A proof as NEW work — `WarehouseQueryAdapter` already shipped in E8; this story CITES it, it does not rebuild it.
- Fixing any bar-A failure the audit surfaces — routes to the owning epic as a bug (audit-not-patch).

## Acceptance criteria

- [ ] A re-runnable check demonstrates the adapter swap with ZERO consumer-facade edits: the same `createAnalytics(config, adapter, deps)` call site works across two adapters (e.g. `NoopAdapter` ↔ a second mock/`RecordingAdapter`), consumer code unchanged — grounded in the E10 Fernly harness.
- [ ] The on-paper second-adapter design names exactly the `AnalyticsAdapter` SPI members a new client adapter must satisfy, and confirms nothing outside the adapter changes (one-adapter, zero-consumer-change).
- [ ] The writeup cites the shipped `WarehouseQueryAdapter` typed stub as the concrete two-adapters-one-interface precedent — bar A is already met on the query side, seam unchanged.
- [ ] Any prose lives inside the S5 scan coverage and passes it (adapters named by role, zero vendor references).

## Technical notes

- **Bar-A grounding (locked):**
  - Client side — the concrete swap is the **E10 Fernly harness** (`examples/fernly/src/harness.ts`): `const adapter = config.key === undefined ? new NoopAdapter() : recorder;` then `createAnalytics(resolvedConfig, adapter, {...})`. Two adapters flow through ONE seam; the consumer facade is identical. The SPI a new adapter fills is `AnalyticsAdapter` in `packages/analytics-kit/src/adapter.ts`.
  - Query side — the **E8 `WarehouseQueryAdapter` typed stub** (`packages/node/src/query/warehouse-query-adapter.ts`) is the shipped bar-A proof: a second adapter behind `AnalyticsQueryClient` with the seam unchanged. Architect (epic Notes, 2026-07-07): pair the concrete swap with the on-paper design to confirm one-adapter-zero-consumer-change.
- **Executable-vs-prose balance:** the SWAP demonstration is a GATED CHECK where feasible (an assertion over the Fernly harness or a small seam-level test that both adapters satisfy the SPI and the consumer call site is unchanged); the second-adapter DESIGN is legitimately PROSE (a paper design of a not-yet-built adapter). Prefer the gate for the swap, prose for the design — per the epic's executable-over-prose-where-possible.
- Note the two bar-A adapter surfaces are DISTINCT: `AnalyticsAdapter` (client ingestion SPI, driven by `AnalyticsProviderImpl`) vs the query adapter behind `AnalyticsQueryClient`. Node's `NodeAnalytics` is a STANDALONE client (not an `AnalyticsAdapter`) — the bar-A story is about the two ADAPTER seams, not the node client shape (E7 Notes).
- No `depends_on`: this audit grounds against already-shipped surfaces (E8, E10) and is independent of the S5 scan and the docs stories. Its prose is subject to the S5 scan once both land, but it needs no output from S5 to be written.

## Shipped
