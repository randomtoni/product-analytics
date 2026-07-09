# Reference backend — contract & scaling story

Companion to `BRIEF.md`. Where the BRIEF defines what the **library** ships, this document defines
the **opinionated backend story** that lets the library scale from project to project: the contract
that binds any backend to the seam, the blessed self-hosted reference architecture (T1 = the
default for every new project), and the graduation ladder. Grounded in two architect consults
(2026-07-07); the posthog-js reference citations are noted inline.

**Standing rule:** everything in "the contract" sections binds adapters. Everything in "the
reference backend" sections is **backend-internal — below the adapter seam** — and must never leak
into library code, types, or docs. The two acceptance bars are the test: (A) provider swap = one
adapter, zero consumer change; (B) new-app adoption = config only, zero library change.

## The line

Opinionated **by reference**, neutral **by contract**. The opinion lives in this contract and in a
reference deployment a new project clones — never in library source, and never left for each
project to re-invent.

| Part | Side of the seam | Where it lives |
|---|---|---|
| Capture SDK | Library (above) | `packages/browser` + `packages/node` |
| Ingest endpoint **contract** | The seam | This document |
| Query **interface** | Library (above) | `AnalyticsQueryClient` (E8) |
| Query request/response **contract** | The seam | This document |
| Storage layout, engines, migrations | Backend (below) | The reference-backend repo (separate) |
| Query **computation** (funnel/retention SQL) | Backend (below) | The reference-backend repo |

The library provides the funnel/retention/trend/uniqueCount **primitives and interface** — it never
computes them. A backend implements the computation; the adapter maps primitive → dialect. The
reference backend keeps its query engine deliberately swappable (Postgres SQL → DuckDB → ClickHouse)
below this line, which is the proof the line is drawn correctly.

## Ingest wire contract

- The seam commits to exactly three neutral touches: config-supplied `ingestHost` + `ingestPath`,
  and the per-event `dedupeId` (E5-S1/S8). Everything else — batch envelope, paths, query params,
  compression headers, back-pressure signals — is `[WIRE]`, adapter-internal, **never** a neutral
  commitment. The seam does not define its own canonical wire format, by design.
- An event's properties cross the wire as a **plain JSON object** (reference:
  `posthog-js/packages/core/src/types.ts:938`). No wire contract may assume a backend column
  layout.
- **Reference-backend decision (v1):** the self-hosted ingest server **speaks the same
  PostHog-compatible capture wire** the release-1 ingestion adapter emits. Consequence: T1 needs
  zero new client code — a project points `ingestHost` at the reference server and the existing
  adapter works unchanged. A future backend MAY ship its own wire; that costs one new adapter,
  nothing else.

## Query contract

- Interface: `funnel({steps, within, breakdown?})` · `retention({cohortEvent, returnEvent,
  periods, granularity, breakdown?})` · `trend({event, aggregation, breakdown?, window})` ·
  `uniqueCount({event, window, breakdown?})` · `rawQuery(expr)` (adapter-specific escape hatch).
- Response shape: snapshot-shaped rows + column metadata, engine-neutral — vendor envelope fields
  are normalized away by the adapter. A Postgres result, a DuckDB result, and a vendor HTTP result
  all surface identically.
- The consumer owns snapshot **storage** and KPI **definitions**; the library owns the query
  **primitives**; the backend owns the **computation**.

## Reference backend architecture — T1 (the default)

**T1 = Neon Postgres only. Zero infra beyond the database the project already provisions.**

Rationale: the query workload is **durable KPI snapshotting** (E8) — a scheduled job running a
handful of funnel/retention/trend queries hourly/daily. That is batch aggregation, not interactive
OLAP; Postgres handles it comfortably to ~10–50M total events with snapshot queries in seconds,
and Neon's scale-to-zero means a DB idle between snapshot runs pays ~nothing. PostHog runs
ClickHouse because it is a multi-tenant SaaS ingesting billions of events across all customers —
a product decision at a scale regime a single self-hosted project is nowhere near; the SDK itself
is storage-agnostic. Most projects never leave T1.

### Schema (backend-internal)

- **Events base table** — append-only, immutable. Real columns only for the taxonomy-independent
  scalars: `event_name`, `distinct_id`, `session_id`, `timestamp` (client event-time), `dedupe_id`
  (unique constraint), plus the server-receive time that drives `dt` partitioning. All
  consumer-defined properties land in one `jsonb` props column — schema-free, lossless,
  drift-proof. Variable props are **not** promoted into physical typed columns.
- **Typed query surface** — a **typed VIEW generated from the consumer's `defineTaxonomy<T>()`
  artifact**: safe-cast projections (`(props->>'plan')::text AS plan`), regenerated on taxonomy
  change (`CREATE OR REPLACE VIEW` — instant, no table rewrite). The funnel/retention/trend SQL
  targets the view, never raw JSONB, so casts live in exactly one generated place. Expression
  indexes on hot props are added only where a specific query demands one (these also give the
  planner real statistics). Never `GENERATED ... STORED` columns (table rewrite per taxonomy
  change), never per-event typed tables (drops out-of-taxonomy events — fatal for a system of
  record).
- **Identity split** — mutable person/group traits live in their own last-write-wins tables; the
  event stream stays immutable. (PostHog's persons-vs-events split, kept.)
- **Codegen ownership** — the reference-backend repo runs the taxonomy→DDL generation (view +
  indexes + optional ingest-time validator) on deploy, consuming the **consumer's** exported
  taxonomy artifact. Zero event names ever enter library code.

### Drift posture

The JSONB log is the drift-proof source of truth; the typed view is an eventually-consistent,
regenerable projection. Out-of-taxonomy or drifted events are **always stored, optionally
quarantined (side table) on gross validation failure, never dropped** — and safe casts (NULL on
bad cast) guarantee one drifted row can never abort a snapshot query. Old clients emitting removed
props lose nothing; new props emitted before a backend redeploy appear in the typed view on
regeneration.

## Day-one invariants

These cost nothing at T1 and are what make every graduation purely additive:

1. **Append-only, immutable events** — no server-side UPDATE/DELETE of captured events, ever.
2. **Events vs identity split** — immutable event stream; mutable persons/groups tables.
3. **Partition-ready timestamps** — partition by `dt` on **server-receive** time (no late-arrival
   reshuffling); client event-time is a separate column.
4. **JSONB base + generated typed views** — (a) variable props stay JSONB at the base with only
   taxonomy-independent scalars as real columns; (b) the typed read surface is generated from the
   taxonomy as views + targeted expression indexes, regenerated on taxonomy change.
5. **Unique `dedupe_id`** — idempotent ingest from day one (retrofit is painful); also keeps the
   later Parquet export dup-free.
6. **Sealed partitions are never rewritten** — after close + late-arrival grace, a partition is
   immutable and export-eligible; stragglers go to a late partition.
7. **Store, never drop** — the drift posture above is an invariant, not a policy choice.

## The graduation ladder

Postgres remains the hot path and **system of record at every tier** — graduation adds a derived
copy and swaps the query adapter's internals; it never migrates data off. Every step is one
adapter swap: zero consumer change (bar A), zero library change (bar B).

| Tier | Shape | Added infra | Graduate when (any) |
|---|---|---|---|
| **T1** (default) | Neon Postgres: ingest → events table; four primitives as Postgres SQL over the typed view | none | events > ~100–200M · storage > ~100 GB (Neon ~$0.35/GB-mo vs object storage ~$0.015–0.023 becomes material) · snapshot latency breaches the batch window or contends with ingest · steady 24/7 traffic defeats scale-to-zero at material volume |
| **T2** | + sealed partitions exported to `events/dt=…/*.parquet` on object storage, queried by DuckDB; adapter routes recent→Postgres, historical→DuckDB (typed view schema = the known Parquet schema, no inference) | bucket + a DuckDB surface (in-process in the node adapter, or a small query service — the `AnalyticsQueryClient` cannot tell the difference) | interactive/sub-second concurrent dashboards · single-node DuckDB can't hold the working set · real-time OLAP freshness at scale |
| **T3** | + dedicated OLAP engine (e.g. ClickHouse) fed from the Postgres system of record (dual-write/CDC) | a real cluster | most projects never reach this |

## Serving the library across projects

Distribution is orthogonal to the backend but is the other half of "scale from project to
project": **publish to public npm under `@analytics-kit/*`, versioned with changesets** —
mirroring how posthog-js itself ships (per-package `publishConfig`/`exports`/`files` +
changesets). The zero-vendor / zero-product posture makes the packages inherently safe to publish
publicly. Setup: claim the `@analytics-kit` scope before first publish; `publishConfig.access:
public` + `files: ["dist"]` + dual ESM/CJS `exports` maps per package; `publint` +
`@arethetypeswrong/cli` gates in CI; pre-registry integration testing via `pnpm pack` tarballs
(not `pnpm link`). Consumers depend with plain semver; stay `0.x` while the seam churns.

## Implications for release-1 epics

- **No structural epic or ROADMAP change.** The seam is already factored for this: E5 keeps the
  wire behind the adapter (only `ingestHost`/`ingestPath` + `dedupeId` are neutral); E8's
  "warehouse" target already names the SQL-over-consumer-owned-store adapter this document blesses.
- **E8-S5** — the warehouse stub's first real fill-in is now the **Postgres-SQL adapter targeting
  the taxonomy-generated typed view** (not raw JSONB, not DuckDB-first); the documented per-method
  SQL mapping ports to DuckDB at T2 (~90% dialect overlap). Still a typed stub in release 1 — no
  scope change.
- **E2 sanity check when it lands** — confirm the adapter SPI stays expressed in capability terms
  (capture/identify/query), never wire terms, so the reference-backend adapter slots in without
  SPI churn.
- **E5 Expansion path** — carries a one-line pointer to this document (the wire-reuse option).
