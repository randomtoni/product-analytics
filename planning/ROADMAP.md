# Roadmap — analytics-kit

Last updated: 2026-07-07

## Status

Greenfield, pre-1.0. Zero focus cycles complete. Current focus: the **`core`** cycle — standing up the vendor-neutral seam (workspace scaffold, the `AnalyticsProvider` contract + config-selected factory, and the typed-taxonomy + allowlist mechanisms) that every other area depends on. Closed epics archive to `epics/done/`; longer cycle narrative lives in `planning/HISTORY.md`.

## Sequencing principle

Work is sequenced **area-first**: each focus cycle stabilizes exactly one canonical area to v1 end-to-end before the next becomes NOW. A cycle's identity is the area it hardens (e.g. "focus area: `capture`"), not a cross-cutting capability slogan. Cross-cutting epics belong to the cycle whose **primary** area they live in. Rationale — this is a pre-1.0 vendor-neutral library shared across many consumer projects, so per-area interface stability beats spreading half-built surface across more areas per cycle. Prioritization is measured against the SOTA / `posthog-js`-capability bar.

After the `core` cycle closes, the user-approved track structure runs three lanes concurrently:

- **{identify → capture → react}** — `E4` (identify) → `E5`, `E6` (capture) → `E9` (react)
- **{node}** — `E7`
- **{query}** — `E8`

The **adoption** cycle (`E10`, `E11`) closes: the example consumer needs the target packages in place, and the audit sweeps the finished surface. LATER lists these cycles in their closing order; the lane structure above is what may overlap.

## NOW

**Focus area: `core`** — the vendor-neutral seam. This cycle stabilizes the workspace, the provider contract + config-selected factory, and the taxonomy + allowlist mechanisms to v1. No consumer-facing capture yet; this is the substrate every target and adapter builds on.

- **[E1-CORE-workspace-scaffold](epics/E1-CORE-workspace-scaffold.md)** *(active)* — pnpm + turbo workspace with all four gates (typecheck / lint / test / build) green on empty packages.
- **[E2-CORE-provider-seam](epics/E2-CORE-provider-seam.md)** *(planned)* — the `AnalyticsProvider` contract + config-selected factory + no-op adapter (silent when unkeyed).
- **[E3-CORE-taxonomy-allowlist](epics/E3-CORE-taxonomy-allowlist.md)** *(planned)* — typed-taxonomy mechanism (`defineTaxonomy<T>()`) + payload-allowlist enforcement hook.

Dependency graph: `E1 → E2 → E3`. E2 and E3 gate every downstream area.

## UPCOMING

**Focus area: `identify`** — anonymous identity and the context bound to every event.

- **[E4-ID-identity-persistence](epics/E4-ID-identity-persistence.md)** — anonymous id generation + persistence, config-supplied cookie domain/scope, memory mode, anonymous→identified merge, session id assignment + expiry, `reset()`.

## LATER

Identified, not yet committed. Listed in closing order; the lanes in [Sequencing principle](#sequencing-principle) are what may overlap.

**`capture` cycle**

- **[E5-CAP-transport](epics/E5-CAP-transport.md)** — batching + compression, retry with backoff, offline queue (survives reloads), sendBeacon/keepalive on unload, config-supplied ingest host/path, dedupe ids, bot/crawler filtering.
- **[E6-CAP-capture-enrichment](epics/E6-CAP-capture-enrichment.md)** — `track` / `page` / pageleave, page + UTM + device/browser context (each opt-out-able), pluggable country source, per-context capture profiles, autocapture opt-in.

**`node` cycle**

- **[E7-NODE-server-capture](epics/E7-NODE-server-capture.md)** — server-side `capture` + trait / group-trait updates, idempotency (caller-suppliable `dedupeId`), no-op without key.

**`query` cycle**

- **[E8-QRY-query-client](epics/E8-QRY-query-client.md)** — `AnalyticsQueryClient` (funnel / retention / trend / uniqueCount + `rawQuery` escape hatch), HTTP query adapter, warehouse stub.

**`react` cycle**

- **[E9-RCT-react-binding](epics/E9-RCT-react-binding.md)** — optional React/Next binding: provider + hooks.

**adoption cycle**

- **[E10-CORE-example-consumer](epics/E10-CORE-example-consumer.md)** — generic example consumer (invented product) under `examples/`, proving new-app adoption is config-only (bar B).
- **[E11-CORE-adoption-audit](epics/E11-CORE-adoption-audit.md)** — README interface→implementation matrix, adopt-in-a-new-app guide, and a bar A / bar B sweep including a vendor/product-name scan.

## Cycle history

| Cycle (area) | Closed | Epics |
|---|---|---|
| _none yet_ | | |

## How to read this file

- **NOW / UPCOMING / LATER** are focus-cycle buckets, not time-boxes. NOW is the area being stabilized this cycle — all epics committed, one marked *(active)*. UPCOMING is the next area (sequence locked). LATER is identified-but-not-yet-committed; order is suggestive.
- **One area per cycle.** A cycle ends when its area's interface surface is v1. No version numbers appear here — versions are git tags applied at cycle close, not planning labels.
- **Epic links** point to `epics/<id>.md`; closed epics move to `epics/done/`. Stories live under `stories/1-backlog/ … 5-done/`.
- **Promotion** (NOW→UPCOMING→LATER) and re-sequencing are user-driven via `/roadmap`; per-epic execution runs through `/implement-epics`. This file is the single source of truth for the plan; narrative history lives in `planning/HISTORY.md`.
