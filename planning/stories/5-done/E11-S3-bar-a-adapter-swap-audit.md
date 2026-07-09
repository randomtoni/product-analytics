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
- [ ] The on-paper second-adapter design names exactly the `AnalyticsAdapter` SPI members a new client adapter must satisfy (the bounded **18-member** interface — see Technical notes; corrected from the draft's erroneous "20", which double-counted the consent pair), and confirms nothing outside the adapter changes (one-adapter, zero-consumer-change).
- [ ] The writeup cites the shipped `HttpQueryAdapter` + `WarehouseQueryAdapter` pair as the concrete two-adapters-one-interface (`AnalyticsQueryClient`) precedent — bar A is already met on the query side, seam unchanged.
- [ ] Any prose lives inside the S5 scan coverage and passes it (adapters named by role, zero vendor references).

## Technical notes

- **Bar-A grounding (locked):**
  - Client side — the concrete swap is the **E10 Fernly harness** (`examples/fernly/src/harness.ts`, verified): `const adapter = config.key === undefined ? new NoopAdapter() : recorder;` then `createAnalytics(resolvedConfig, adapter, { generateUuid: … })`. Two adapters (`NoopAdapter` from `analytics-kit`, `RecordingAdapter` from `examples/fernly/src/recording-adapter.ts` — `class RecordingAdapter implements AnalyticsAdapter`) flow through ONE seam; the consumer facade is identical. The SPI a new adapter fills is `AnalyticsAdapter` in `packages/analytics-kit/src/adapter.ts` — a concrete, BOUNDED **18-member** interface (verified against source: `capture`, `identify`, `register`, `unregister`, `reset`, `getDistinctId`, `group`, `alias`, `flush`, `shutdown`, `getConsentState`, `setConsentState`, `fetch`, `getPersistedProperty`, `setPersistedProperty`, `getLibraryId`, `getLibraryVersion`, `getCustomUserAgent` = 18). The draft said "20" — a miscount that double-counted the consent pair (`getConsentState`/`setConsentState` are already in the list); the shipped design + swap test use the verified 18. The on-paper design enumerates THIS 18-member surface — a finite fill-in-the-blanks list, not an open-ended sketch.
  - Query side — the **E8 `WarehouseQueryAdapter` typed stub** (`packages/node/src/query/warehouse-query-adapter.ts`) is the shipped bar-A proof: it sits behind `AnalyticsQueryClient` alongside the already-shipped `HttpQueryAdapter` (`packages/node/src/query/http-query-adapter.ts`) — TWO adapters, ONE `AnalyticsQueryClient` interface, seam unchanged (both are real exports from `@analytics-kit/node`, verified). Architect (epic Notes, 2026-07-07): pair the concrete swap with the on-paper design to confirm one-adapter-zero-consumer-change.
- **Executable-vs-prose balance:** the SWAP demonstration is a GATED CHECK where feasible (an assertion over the Fernly harness or a small seam-level test that both adapters satisfy the SPI and the consumer call site is unchanged); the second-adapter DESIGN is legitimately PROSE (a paper design of a not-yet-built adapter). Prefer the gate for the swap, prose for the design — per the epic's executable-over-prose-where-possible.
- Note the two bar-A adapter surfaces are DISTINCT: `AnalyticsAdapter` (client ingestion SPI, driven by `AnalyticsProviderImpl`) vs the query adapter behind `AnalyticsQueryClient`. Node's `NodeAnalytics` is a STANDALONE client (not an `AnalyticsAdapter`) — the bar-A story is about the two ADAPTER seams, not the node client shape (E7 Notes).
- No `depends_on`: this audit grounds against already-shipped surfaces (E8, E10) and is independent of the S5 scan and the docs stories. Its prose is subject to the S5 scan once both land, but it needs no output from S5 to be written.

## Shipped
- > Reviewer suggestion (2026-07-09, applied at ship): the AC/notes' "20-member" was a miscount (double-counted the consent pair) — corrected to the verified **18** in this story's AC + Technical notes; the shipped design + swap test already use 18.
- > Reviewer suggestion (2026-07-09, improvement-pass): swap-test #2 asserts the keyed path is `RecordingAdapter`-backed but not that the unkeyed path is `NoopAdapter`-backed (the harness returns `recorder` unconditionally) — the proof isn't weakened (test #4 shows the Noop-backed run records nothing), but a one-line pointer from #2 to #4 would make the suite self-documenting.

## Shipped

> Captured by `implement-epics` on 2026-07-09. The bar-A proof (reviewer-verified HONEST, not hollow).

- **Files added:** `examples/fernly/src/bar-a-adapter-swap.test.ts` (4 gated tests — the re-runnable bar-A swap check)
- **Files changed:** `README.md` (a `## Bar A: provider-swap = one adapter, zero consumer change` section — the 18-member `AnalyticsAdapter` SPI fill-in table + the demonstrated swap + the query-side precedent)
- **New public API:** none — audit (test + docs). NO impl changed; NO real 2nd adapter built; `WarehouseQueryAdapter` CITED not rebuilt (audit-not-patch).
- **The gated swap check (reviewer-verified HONEST):** (1) both `NoopAdapter` + `RecordingAdapter` structurally satisfy the 18-member `AnalyticsAdapter`; (2) the SAME `createFernlyAnalytics(config)`→`createAnalytics(config,adapter,deps)` call site flows BOTH through ONE seam (unkeyed→Noop, keyed→Recording), consumer code UNCHANGED; (3) the returned facade `keyof` is BYTE-IDENTICAL across the swap (a real prototype-walk structural comparison — sorted, function-only, `_`-private-stripped — NOT a tautology); (4) the SAME neutral `drive()` sequence runs identically against either backend, the behavioral difference (Noop records nothing, Recording captures `signup_started`/`user-42`) living ENTIRELY behind the seam.
- **On-paper 2nd-adapter design:** enumerates the REAL `AnalyticsAdapter` **18-member** SPI (`capture`/`identify`/`register`/`unregister`/`reset`/`getDistinctId`/`group`/`alias`/`flush`/`shutdown`/`getConsentState`/`setConsentState`/`fetch`/`getPersistedProperty`/`setPersistedProperty`/`getLibraryId`/`getLibraryVersion`/`getCustomUserAgent`) — a finite fill-in list; a new backend = ONE adapter, facade/config/taxonomy/consumer untouched. **Count corrected 20→18** (builder + reviewer independently verified vs `adapter.ts`; the draft double-counted the consent pair).
- **Query-side precedent (real):** cites `HttpQueryAdapter` + `WarehouseQueryAdapter` — TWO adapters, ONE `AnalyticsQueryClient` interface, seam unchanged (both real `@analytics-kit/node` exports). Bar A already met on the query side.
- **Neutrality:** README prose passes S5 (`fetch` described as "the transport primitive — neutral request/response shape", not an endpoint); the two DISTINCT adapter surfaces (`AnalyticsAdapter` client-SPI vs the query adapter behind `AnalyticsQueryClient`; `NodeAnalytics` is a STANDALONE client, NOT an adapter) kept distinct, not conflated. `pnpm neutrality-scan` PASSES (15).
- **Tests added:** fernly +4 (SPI-conformance-both-adapters, same-call-site-two-adapters, facade-keyof-byte-identical, same-sequence-difference-behind-seam) → 83; gates green (build/test/typecheck/lint 14 + neutrality-scan 15).
- **Commit:** `E11-S3-bar-a-adapter-swap-audit — Bar A: provider-swap = one adapter, zero consumer change` on `core-cycle`
- **Reviewer notes:** ship-ready — 0 critical, 2 suggestions (20→18 correction APPLIED; test #2 self-doc pointer)
- **Cross-story seams exposed (S4 — LAST E11 story):** bar-B verification (a GATED `examples/fernly` diff-is-`examples/**`-only assertion proving S2's prose claim) + capability-completeness (a PROSE coverage table vs posthog-js scoped to the BRIEF contract, `flags?`/`replay?` declared-only rows) backed by a GATED frozen-15 + node-3 + query-5 export/type-PRESENCE assertion over `dist` (TYPECHECK-time for the type-only interface exports, NOT `Object.keys()`). Same S5 scan rules on the prose.
