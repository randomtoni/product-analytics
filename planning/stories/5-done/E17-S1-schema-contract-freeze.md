---
id: E17-S1-schema-contract-freeze
epic: E17-ADP-warehouse-substrate
status: ready-for-dev
area: adapters
touches: [query, node]
depends_on: []
api_impact: additive
---

# E17-S1-schema-contract-freeze — Freeze the warehouse events-schema contract (the one-way door)

## Why

Everything else in the self-host cycle binds to ONE column contract: the receiver writes it (E19),
the query SQL reads it (E18), the typed-view generator projects over it (S2). Freezing that contract
as a committed doc — reviewed before any SQL or receiver binds — is the one-way door. This is a
planning-doc story: no production code, a doc plus its review gate.

## Scope

### In

- Write **`planning/WAREHOUSE-SCHEMA-CONTRACT.md`** with the same rigor as
  `planning/QUERY-ROW-CONTRACT.md` (its sibling read-contract). It states, as the frozen source of
  truth both language trees bind to:
  - **The `events` column contract.** The library-owned `events` table columns and their roles:
    - `distinct_id` — the actor identity (from the wire `distinct_id`).
    - `event` — the event name (from the wire `event`).
    - `timestamp` — the event time (from the wire `timestamp`, optional on the wire; state the
      receiver-side default when absent, e.g. server-receipt time — leave the exact default to E19,
      but note the column is NOT NULL by contract).
    - `uuid` — the idempotency key, **UNIQUE** (from the wire `uuid`, carried verbatim from the
      neutral `dedupeId`). State that the UNIQUE constraint is what makes E19's receiver-write an
      idempotent upsert (`ON CONFLICT (uuid) DO NOTHING`) — client/server retries dedupe on one
      agreed value.
    - `properties` — a **`jsonb`** column holding the full neutral property bag verbatim.
  - **The typed-VIEW generation rule.** The taxonomy-driven typed VIEW is a set of **safe-cast
    projections over the `properties` JSONB base — never raw JSONB exposed to query SQL**. State the
    rule precisely: each taxonomy-declared **event property** becomes a view column that safe-casts
    the JSONB path (e.g. `(properties ->> 'plan')::text`, `(properties ->> 'count')::numeric`) per its
    declared `PropType` (`string → text`, `number → numeric`, `boolean → boolean`, `date →
    timestamptz`), so query SQL (E18) targets typed view columns generically, never `properties`
    directly. State that a safe cast tolerates a missing/mistyped key (yields NULL, not an error) —
    the greenfield/loose-JSONB posture. No consumer event/domain name is baked into the generator;
    it reads the taxonomy.
  - **State the projection SOURCE precisely (the positive rule that pairs with the guard below).**
    The generator projects columns from the taxonomy's **event property declarations** — the union of
    prop keys across `decl.events`' `PropDecl` values (`events: Record<string, PropDecl>` in TS /
    `events: dict[str, PropDecl]` in Python; `PropDecl = { propKey: PropType }`). It does NOT project
    the `traits`/`groups`/`page`/`flags` decl slots into view columns: `traits`/`groups` keys are the
    JSONB-nesting guard below; `page` is a browser-only taxonomy slot **absent from the Python
    `TaxonomyDecl` by design** (a documented server omission — Python has no page surface); `flags` are
    inbound flag payloads, not stored event columns. Naming the source as "event-property decls only"
    keeps the two trees' generators identical despite the `page`-slot asymmetry (the slot the generator
    never reads).
  - **The trait/group JSONB-nesting guard.** The de-branded trait/group keys —
    `set` / `set_once` / `group_type` / `group_key` / `group_set` — are nested INSIDE `properties`
    by the node wire-mapper (`ts/packages/node/src/wire-mapper.ts:16-20`), and the receiver (E19)
    persists them as-is into the `properties` JSONB column. State the guard explicitly: **no view
    column is ever named after these keys** — they live only inside `properties`, never as a
    projected typed column. This prevents the taxonomy's `traits`/`groups` decls from colliding with
    the event property projections.
  - **The greenfield note.** The target consumer has no existing PostHog deployment or data, so
    there is **no backfill / migration-from-vendor concern** — the schema is designed to receive the
    existing neutral node batch envelope directly, not to match a legacy shape. State this so E18/E19
    don't design around a nonexistent legacy.
  - **The wire↔column mapping.** State that the `events` column set IS the existing neutral node
    batch envelope `WireEvent { uuid, event, distinct_id, properties?, timestamp? }`
    (`ts/packages/node/src/wire-mapper.ts:36-42`) — the schema is designed to receive that envelope
    directly, NOT PostHog's `$`-prefixed shape. This is the invariant that makes E19's receiver a
    thin persist over the existing wire.
  - **The parity note.** Mark the contract as the shared source of truth BOTH trees bind to (mirror
    `QUERY-ROW-CONTRACT.md`'s parity framing): TS's typed-view generator (S2) and Python's (S2) both
    project this exact column set + view rule, cased idiomatically only where a language forces it
    (the SQL itself is identical — Postgres DDL is language-agnostic).
- Cross-reference the sibling read contract (`planning/QUERY-ROW-CONTRACT.md`) so the two contracts
  read as a pair (write contract + read contract).

### Out

- The DDL / migration file itself and the typed-view generator code — **S2** (this story freezes the
  contract they bind to; it writes no SQL, only the contract prose that governs the SQL).
- The DB-execute protocol seam + driver extra — **S3**.
- The `warehouse_dsn` config field + selection ladder — **S4**.
- The warehouse query SQL bodies — **E18**. The ingest receiver — **E19**.
- Any change to `planning/QUERY-ROW-CONTRACT.md` (the read contract already ships) — cross-reference
  only, do not edit it.

## Acceptance criteria

- [ ] `planning/WAREHOUSE-SCHEMA-CONTRACT.md` exists and freezes: the `events` column contract
      (`distinct_id`, `event`, `timestamp`, `uuid` UNIQUE, `properties` jsonb) with each column's
      role and the `uuid`-UNIQUE → idempotent-upsert rationale.
- [ ] The doc states the typed-VIEW generation rule: safe-cast JSONB projections per declared
      `PropType`, never raw JSONB to query SQL, taxonomy-driven, no consumer name baked in.
- [ ] The doc states the projection SOURCE: columns come from the taxonomy's **event-property**
      decls only (`decl.events` prop keys), not the `traits`/`groups`/`page`/`flags` slots — so the
      TS `page`-slot / Python-no-`page` asymmetry never reaches the generator.
- [ ] The doc states the trait/group JSONB-nesting guard explicitly: `set` / `set_once` /
      `group_type` / `group_key` / `group_set` live only inside `properties`; no view column is named
      after them.
- [ ] The doc states the greenfield/no-backfill note and the wire↔column identity (the `events`
      column set IS `WireEvent`, receives the existing node batch envelope directly, not a `$`-shape).
- [ ] The doc is marked as the shared write-side contract both trees bind to (parity framing
      mirroring `QUERY-ROW-CONTRACT.md`) and cross-references `QUERY-ROW-CONTRACT.md`.
- [ ] Zero vendor/engine-internal token in the doc. `planning/` is NOT in the neutrality-scan surface
      (the scan covers `packages/**` + `ts/README.md`), so keep it vendor-clean BY HAND — the
      reviewer is the backstop. The one dev-only exemption (a `De-branded from posthog's …` provenance
      note) does NOT apply to `planning/` docs; use none.

## Technical notes

This is a planning-doc-only story — no `src/`, `tests/`, or manifest changes. `api_impact: additive`
(a doc). It is the **one-way-door gate**: it MUST land and be reviewed before S2/S3/S4 and before
E18/E19 — the whole cycle binds to the contract it freezes.

**Pre-resolved decisions (locked by the epic Notes — do not re-litigate; architect 2026-07-13):**

- **The `events` column contract is fixed:** `distinct_id`, `event`, `timestamp`, `uuid` UNIQUE,
  `properties` jsonb. This is deliberately the existing neutral node batch envelope `WireEvent`
  (`ts/packages/node/src/wire-mapper.ts:36-42`) — `{ uuid, event, distinct_id, properties?,
  timestamp? }` — so E19's receiver is a thin persist over the wire the transport already speaks. Do
  NOT design the schema around PostHog's `$`-shape. — architect (2026-07-13)
- **The typed VIEW is safe-cast projections over JSONB, never raw JSONB.** The generator reads the
  taxonomy (`ts/packages/analytics-kit/src/taxonomy.ts` — `PropType` = `string`/`number`/`boolean`/
  `date`; `TaxonomyDecl.events` maps event → `PropDecl`) and emits one typed view column per declared
  property, casting the JSONB path per `PropType`. Query SQL (E18) never touches `properties`
  directly. This mirrors the intent already documented in the warehouse-adapter stub's
  fill-in-seat comment (`ts/packages/node/src/query/warehouse-query-adapter.ts:18-21`). — architect
  (2026-07-13)
- **Trait/group keys nest inside `properties`; no view column is named after them.** The node
  wire-mapper nests de-branded `set`/`set_once`/`group_type`/`group_key`/`group_set` INSIDE
  `properties` (`wire-mapper.ts:16-20`, `WIRE_SET_KEY` … `WIRE_GROUP_SET_KEY`). The receiver persists
  them as-is; the contract must name this guard so the view generator never collides a `traits`/
  `groups` decl with an event-property projection. — architect (2026-07-13)
- **Greenfield = no backfill.** The target consumer has no existing deployment/data; state that there
  is no migration-from-vendor concern. — architect (2026-07-13)
- **Taxonomy-shape asymmetry the contract must survive (verified against both trees, story-refiner
  2026-07-14).** The generator reads ONLY event-property decls, which are shaped identically in both
  trees (`events: Record<string, PropDecl>` TS / `events: dict[str, PropDecl]` Python, `PropDecl =
  { propKey: PropType }`, `PropType = 'string'|'number'|'boolean'|'date'`). The known asymmetries —
  TS `TaxonomyDecl` carries a `page` slot, Python omits it by design (server has no page surface,
  documented in `python/src/analytics_kit/taxonomy.py`); TS `PropsOf`/`ShapeOf` mapped types have no
  Python analogue (const-generic wall) — do NOT touch the generator, because it projects event-prop
  decls only and never the `page`/mapped-type surfaces. State in the contract that the view rule binds
  to the event-property decl shape (symmetric), so both trees emit identical view SQL for the same
  taxonomy. This is what makes S2's byte-equivalence parity assertion achievable.

**Rigor reference:** `planning/QUERY-ROW-CONTRACT.md` is the sibling doc to mirror — same "why a
contract / the shape / per-thing tables / the executable form / parity framing" structure. This is
the WRITE-side contract; that is the READ-side contract; together they bound the self-host loop.

> Reviewer suggestion (2026-07-14): pin a deterministic column-emission order (base columns first,
> then event-property projections stable-sorted by prop key) so both trees emit byte-identical view
> SQL — the load-bearing precondition for S2's parity assertion. ADDRESSED before ship: added the
> "Deterministic column order" subsection to `WAREHOUSE-SCHEMA-CONTRACT.md` and conditioned the two
> byte-identical parity claims on it.
> Reviewer suggestion (2026-07-14): unify the two "byte-identical view SQL" assertions and condition
> them on the ordering rule. ADDRESSED: both now read as consequences of the deterministic-order rule.

## Shipped

> Captured by `implement-epics` on 2026-07-14.

- **Files changed:** none (planning-doc-only story)
- **Files added:** `planning/WAREHOUSE-SCHEMA-CONTRACT.md` — the frozen write-side `events` schema contract (the one-way door)
- **New public API:** none — a planning contract doc
- **Tests added:** none (doc-only; by-hand neutrality grep in lieu of a suite — 0 vendor/engine tokens)
- **Commit:** this story's ship commit on `main` (see `git log`)
- **Reviewer notes:** no criticals; 2 suggestions, BOTH addressed in-story before ship (see Technical notes) — the deterministic column-order pin + unified parity wording, landed so S2 binds to the complete contract
- **Cross-story seams exposed:** S2's typed-view generator MUST emit columns base-first (`distinct_id`, `event`, `timestamp`, `uuid`) then event-property keys **stable-sorted by prop key** — that ordering is what makes S2's byte-identical parity assertion hold. S2/S3/S4 + E18/E19 all bind to the frozen column set (`distinct_id`, `event`, `timestamp` NOT NULL, `uuid` UNIQUE, `properties` jsonb) + the event-property-decls-only safe-cast typed-view rule.
