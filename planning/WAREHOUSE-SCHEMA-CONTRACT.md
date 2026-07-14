# Warehouse schema contract — the frozen write-side `events` column shape

**Status:** frozen (epic E17, self-host cycle). This is the **one-way door**: the receiver writes it
(E19), the warehouse query SQL reads it (E18), and the taxonomy-generated typed view projects over it
(E17-S2). It is committed and reviewed BEFORE any SQL or receiver binds to it.

This is the **write-side** contract. Its sibling is the read-side
[`QUERY-ROW-CONTRACT.md`](./QUERY-ROW-CONTRACT.md) — that document fixes the neutral per-primitive row
shapes a query *returns*; this one fixes the neutral column shape events are *stored under*. Read them
as a pair: writes land in the `events` table under this contract, reads project back out under that
one.

Parity is **by shared contract, not shared code** — both language trees bind to the exact column set
and view-generation rule below. Neither tree imports the other; both emit the **same** Postgres DDL
and view SQL for the same taxonomy (the SQL is language-agnostic — only the surrounding generator code
is cased idiomatically per language). This is the shared source of truth both trees bind to.

## Why a schema contract

The library owns the `events` table schema — not the consumer, and not each backend independently —
because **receiver-writes (E19) and query-reads (E18) must agree on ONE column contract by
construction.** If the receiver wrote one column shape and the query SQL read another, a provider swap
would silently break. Freezing the columns as a committed contract, reviewed once, is what lets the
two ends bind to the same shape without coordinating at implement time. The consumer provisions the
database and runs the shipped migration; the library dictates the columns.

The schema is a **one-way door**: everything downstream binds to it, so it is frozen here as prose
before a single line of DDL, view SQL, or receiver code is written.

## The `events` column contract

The library-owned `events` table has exactly these columns. This column set **is** the existing
neutral node batch envelope `WireEvent` (see [Wire ↔ column identity](#wire--column-identity) below) —
one column per wire field, so the receiver is a thin persist over the wire the transport already
speaks.

| Column | Type | Constraints | Role | Source (wire field) |
|---|---|---|---|---|
| `distinct_id` | text | NOT NULL | The actor identity — the id the event is attributed to. | `distinct_id` |
| `event` | text | NOT NULL | The event name (the consumer's own vocabulary; the library ships none). | `event` |
| `timestamp` | timestamptz | NOT NULL | The event time. | `timestamp` (optional on the wire) |
| `uuid` | uuid / text | **UNIQUE**, NOT NULL | The idempotency key — one agreed value client and server dedupe on. | `uuid` (verbatim from the neutral `dedupeId`) |
| `properties` | **jsonb** | — | The full neutral property bag, stored verbatim. | `properties` |

### `timestamp` is NOT NULL by contract, with a receiver-side default

The wire field `timestamp` is **optional** — a `WireEvent` may omit it. The `events` column, however,
is **NOT NULL by contract**: when the wire event carries no `timestamp`, the receiver (E19) supplies a
default (e.g. server-receipt time). The exact default value is E19's to fix; this contract pins only
that the **column is NOT NULL** — every stored row has a real event time, so query SQL never
special-cases a null timestamp.

### `uuid` is UNIQUE → the receiver-write is an idempotent upsert

The `uuid` column carries the wire `uuid` **verbatim** — which is itself carried verbatim from the
neutral `dedupeId`. Because it is the same agreed value on the client and the server, a **UNIQUE
constraint on `uuid`** is exactly what makes E19's receiver-write **idempotent**: the write is an
`INSERT … ON CONFLICT (uuid) DO NOTHING` upsert, so a client retry, a server retry, or a
double-delivery of the same event collapses to a single stored row. Retries dedupe on one agreed
value by construction — no application-level de-duplication pass is needed.

### `properties` is the verbatim neutral bag

`properties` is a **`jsonb`** column holding the complete neutral property bag exactly as it arrived on
the wire — no reshaping, no key-lifting, no extraction of individual properties into their own columns.
Everything the consumer sent (and everything the trait/group verbs nested inside it — see the
[nesting guard](#traitgroup-jsonb-nesting-guard)) lives here. Individual typed access happens through
the typed view, not by reading `properties` in query SQL.

## The typed-VIEW generation rule

Query SQL (E18) **never targets `properties` directly**. It targets a taxonomy-generated **typed
view** — a set of **safe-cast JSONB projections** over the `events` base table. This keeps every query
body generic (it selects named, typed columns), keeps the raw JSONB out of query SQL, and keeps all
consumer-specific column knowledge in one generated artifact instead of scattered across query bodies.

The generator is **taxonomy-driven and bakes in no consumer name.** It reads the taxonomy declaration
and emits **one view column per declared event property**, casting the JSONB path to a concrete SQL
type per the property's declared `PropType`:

| Declared `PropType` | SQL cast | Example projection |
|---|---|---|
| `string` | `text` | `(properties ->> 'plan')::text AS plan` |
| `number` | `numeric` | `(properties ->> 'count')::numeric AS count` |
| `boolean` | `boolean` | `(properties ->> 'is_trial')::boolean AS is_trial` |
| `date` | `timestamptz` | `(properties ->> 'started_at')::timestamptz AS started_at` |

The view also carries the base columns (`distinct_id`, `event`, `timestamp`, `uuid`) through
unchanged, so query SQL selects everything it needs from the view alone.

### Deterministic column order (what makes parity byte-exact)

The generator emits view columns in **one deterministic order across both trees**: the base columns
first, in the fixed order (`distinct_id`, `event`, `timestamp`, `uuid`), then the event-property
projections **stable-sorted by prop key** (ascending, byte-wise on the key string) over the
`decl.events` union. This ordering rule is load-bearing for parity: a prop key can appear on multiple
events, and the two trees walk their taxonomies with different native constructs (a JS object-key walk
vs a Python set-union) whose iteration order is **not** guaranteed to coincide. Sorting by prop key
removes that dependency, so both generators emit the columns in the same order — the precondition for
the byte-identical view SQL the parity section promises. Absent this rule, each tree could satisfy the
letter of the contract and still diverge byte-wise.

### Safe casts tolerate missing / mistyped keys (yield NULL, not an error)

Each projection is a **safe cast**: a key absent from a given row's `properties`, or present but
holding a value that can't be cast to the declared type, yields **NULL** for that column on that row —
**never a query error.** This is the greenfield / loose-JSONB posture: the JSONB base is not
row-schema-enforced, so the view tolerates ragged data by design. A query over the view sees NULL
where a value is missing or unusable, and aggregates over it accordingly — the same way a nullable
column behaves.

(The concrete safe-cast SQL form — e.g. guarding the `::` cast so a malformed value returns NULL
instead of raising — is E17-S2's to choose; this contract fixes the *behavior*: missing/mistyped ⇒
NULL, never an error.)

## The projection SOURCE — event-property decls only

The generator projects view columns from **exactly one slot** of the taxonomy: the **event-property
declarations**. Concretely, it takes the **union of prop keys across the values of `decl.events`** —
where `events` is `Record<string, PropDecl>` (TS) / `dict[str, PropDecl]` (Python) and
`PropDecl = { propKey: PropType }`. Each distinct declared prop key across all events becomes one
safe-cast view column, typed by its declared `PropType`.

It projects **none** of the other taxonomy slots into view columns:

- **`traits` / `groups`** — these are the [JSONB-nesting guard](#traitgroup-jsonb-nesting-guard)
  below. Their keys live inside `properties`, never as their own view column.
- **`page`** — a browser-only taxonomy slot. It exists on the TS `TaxonomyDecl` (for browser pageview
  typing) and is **absent from the Python `TaxonomyDecl` by design** — a documented server omission
  (the server has no page surface). The generator never reads it in either tree.
- **`flags`** — inbound flag payloads (server → client), not stored event columns. The generator never
  projects them.

Naming the source as **"event-property decls only"** is what keeps the two trees' generators
**identical despite the `page`-slot asymmetry.** Because the generator reads only `decl.events` — the
one slot shaped identically in both trees (`events: Record<string, PropDecl>` /
`events: dict[str, PropDecl]`) — the presence of `page` on the TS decl and its absence on the Python
decl **never reaches the generator.** Combined with the
[deterministic column order](#deterministic-column-order-what-makes-parity-byte-exact), both trees
emit byte-identical view SQL for the same taxonomy.

## Trait/group JSONB-nesting guard

The de-branded trait/group keys — **`set`**, **`set_once`**, **`group_type`**, **`group_key`**,
**`group_set`** — are nested **INSIDE `properties`** by the node wire-mapper
(`ts/packages/node/src/wire-mapper.ts:16-20`); they are wire-internal property keys, not top-level
fields. The receiver (E19) persists them **as-is** into the `properties` `jsonb` column, exactly as
received.

**The guard: no view column is ever named after these keys.** They live only inside `properties`,
never as a projected typed column. This is a hard rule the view generator must honor so that a
`traits` or `groups` declaration in the taxonomy can **never collide** with an event-property
projection — the generator projects only event-property decls (see
[the projection source](#the-projection-source--event-property-decls-only)), and the trait/group
material is deliberately left inside the JSONB bag. Trait and group data is reachable by reading
`properties` directly in the rare case a query needs it, but it is not, and must not be, a first-class
view column.

## Greenfield — no backfill / migration-from-vendor concern

The target consumer is **greenfield**: it has no existing analytics deployment and no existing data to
match. There is therefore **no backfill or migration-from-a-prior-vendor concern** to design the
schema around. The schema is designed to **receive the existing neutral node batch envelope directly**
(see below), not to reproduce or match any legacy stored shape. E18/E19 must not design around a
nonexistent legacy: there is no historical column layout to be compatible with, only this contract.

## Wire ↔ column identity

The `events` column set **is** the existing neutral node batch envelope
`WireEvent { uuid, event, distinct_id, properties?, timestamp? }`
(`ts/packages/node/src/wire-mapper.ts:36-42`). This is deliberate and is the invariant that makes
E19's receiver a **thin persist over the wire the transport already speaks**:

- `uuid` ← wire `uuid` (verbatim from the neutral `dedupeId`)
- `event` ← wire `event`
- `distinct_id` ← wire `distinct_id`
- `timestamp` ← wire `timestamp` (or the receiver default when the wire omits it)
- `properties` ← wire `properties` (verbatim, jsonb)

The schema receives **this** envelope directly. It is **not** designed around any vendor's
prefixed/special-keyed event shape — the transport↔receiver wire (E19) reuses this exact neutral
envelope, so no translation layer sits between the wire and the column. One shape, wire to column.

## Parity — the shared write-side contract both trees bind to

This is the **shared source of truth both language trees bind to** (mirroring
[`QUERY-ROW-CONTRACT.md`](./QUERY-ROW-CONTRACT.md)'s parity framing). The TS typed-view generator
(E17-S2) and the Python typed-view generator (E17-S2) both project **this exact column set and this
exact view rule**:

- The **DDL** (the `events` table columns, types, and constraints above) is identical Postgres —
  language-agnostic.
- The **view SQL** (one safe-cast projection per declared event property, per the `PropType` → SQL
  cast table above) is identical for the same taxonomy — the generator reads the symmetric
  event-property decl shape in both trees, so both emit the same SQL.
- Only the **surrounding generator code** (how each tree walks its taxonomy and assembles the SQL
  string) is cased idiomatically per language.

Because the view rule binds to the **event-property decl shape** — which is symmetric across the two
trees — and both generators emit columns in the same
[deterministic order](#deterministic-column-order-what-makes-parity-byte-exact), both trees produce
byte-identical view SQL for the same taxonomy. That symmetry, plus the ordering rule, is what makes
E17-S2's parity assertion achievable, and it is why the known taxonomy asymmetries (the TS-only `page`
slot, the TS-only `PropsOf`/`ShapeOf` mapped types) are irrelevant to this contract: the generator
never reads them.

## The contract in one sentence

Events are stored under one library-owned column set — `distinct_id`, `event`, `timestamp` (NOT NULL),
`uuid` (UNIQUE, the idempotency key), `properties` (jsonb) — that **is** the neutral node batch
envelope; the query side reads them only through a taxonomy-generated typed view of safe-cast JSONB
projections (event-property decls only; trait/group keys stay nested in `properties`); both language
trees bind to this one shape.
