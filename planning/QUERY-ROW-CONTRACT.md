# Query row contract — the shared per-primitive neutral row shape

**Status:** shipped on the TS seam (epic E15, R-cycle). This is the **source of truth the Python
query client ports TO.**

Parity is **by shared contract, not shared code** — the shipped `ts/` seam is the reference the
Python port ports *to* (mirrors the `Python parity` cycle precedent). Neither tree imports the other;
both satisfy the field set below, each cased idiomatically for its language. When the Python query
cycle lands, its query client MUST produce these same row concepts under Python snake_case.

## Why a row contract

The read-side envelope (`QueryResult`) is structurally neutral, but without a **row** contract the
four structured primitives passed backend insight objects through as-is, leaking engine-internal
column keys to consumers. The fix is to normalize each primitive's response into a documented neutral
row shape: the row fields below are the stable conformance surface consumers key on, and the only
guarantee a provider swap (HTTP backend → SQL warehouse) preserves. No engine-internal key appears in
any returned row.

## The envelope

The generic envelope is `QueryResult<TRow = Record<string, unknown>>`. The four structured primitives
narrow `TRow` to their per-primitive row type; `rawQuery` keeps the default. Envelope fields (`rows`,
`columns`, `generatedAt`, `fromCache?`) are shared across both languages and out of scope here — this
document defines the **row** (`TRow`) contract.

## Field concepts

The neutral field concepts, shared across both languages. TS uses camelCase; Python uses snake_case.
The camelCase names are the frozen conformance surface for TS consumers; the snake_case names are the
idiomatic port target for Python and appear ONLY in this artifact — never in the TS surface.

| Concept | TS field | Python cases as | Meaning |
|---|---|---|---|
| bucket | `bucket` | `bucket` | Time-bucket label for a trend/unique-count data point. |
| value | `value` | `value` | The numeric measure for a bucket (trend) or a cohort×period cell (retention). |
| breakdown | `breakdown` | `breakdown` | Optional; the breakdown-group label, stringified onto every row of that group. |
| step | `step` | `step` | Zero-based funnel step index. |
| event | `event` | `event` | The funnel step's resolved event/action identity. |
| count | `count` | `count` | Number of distinct ids reaching a funnel step. |
| conversionRate | `conversionRate` | `conversion_rate` | Computed step conversion relative to the first step (per-group when broken down); guarded so a zero first step yields `0`, not `NaN`/`Infinity`. |
| cohort | `cohort` | `cohort` | Retention cohort start label. |
| periodIndex | `periodIndex` | `period_index` | Zero-based period offset within a cohort; index `0` is the cohort's own period. |

## Per-primitive row shapes

Each primitive returns `QueryResult<TRow>` narrowed to the row shape below. `breakdown?` is present on
a row only when the query was broken down.

### `trend` — one row per time bucket

| Concept | TS | Python |
|---|---|---|
| bucket | `bucket: string` | `bucket: str` |
| value | `value: number` | `value: float` |
| breakdown (optional) | `breakdown?: string` | `breakdown: str | None` |

TS row type: `TrendRow`. One row per bucket; one row-series per breakdown value when broken down.

### `uniqueCount` — its own named concept, same field set as `trend`

`uniqueCount` returns the **same field set as `trend`** (`bucket`, `value`, `breakdown?`) — it is a
trend computed with distinct-id math. On the TS seam it is a distinct named concept, `UniqueCountRow`,
aliased to `TrendRow`.

**Port note (parity):** the alias is a TS convenience. The Python port MUST keep `uniqueCount` as its
**own named primitive with its own named row concept** — do NOT collapse it into `trend` and lose the
primitive's identity. Same fields, distinct role.

### `funnel` — one row per funnel step

| Concept | TS | Python |
|---|---|---|
| step | `step: number` | `step: int` |
| event | `event: string` | `event: str` |
| count | `count: number` | `count: int` |
| conversionRate | `conversionRate: number` | `conversion_rate: float` |
| breakdown (optional) | `breakdown?: string` | `breakdown: str | None` |

TS row type: `FunnelStepRow`. `conversionRate` is **computed** (this step's count over the first
step's count), not a wire field; per-group when broken down; guarded to `0` when the first step is
`0`.

### `retention` — one row per cohort×period cell

| Concept | TS | Python |
|---|---|---|
| cohort | `cohort: string` | `cohort: str` |
| periodIndex | `periodIndex: number` | `period_index: int` |
| value | `value: number` | `value: float` |
| breakdown (optional) | `breakdown?: string` | `breakdown: str | None` |

TS row type: `RetentionRow`. One row per (cohort, period) cell; `periodIndex` `0` is the cohort's own
period.

### `rawQuery` — verbatim column-keyed pass-through (the default `TRow`)

`rawQuery` keeps the default `TRow` (`Record<string, unknown>` in TS; a plain string-keyed mapping in
Python). Its rows are keyed by the consumer's own SELECT projection — the one place a dialect-keyed
shape legitimately surfaces. There is no narrowed row concept; the keys are whatever the query
projected.

## The executable form of the contract

The per-primitive wire→neutral-row fixtures at
[`../ts/packages/node/src/query/query-contract.fixtures.ts`](../ts/packages/node/src/query/query-contract.fixtures.ts)
are the executable form of this contract: each fixture pairs a realistic backend `results` payload
with the exact neutral rows the normalizer must produce, and the row-level seal tests assert no
engine-internal key survives. The Python port should port to those fixtures' expected-row shapes.

## Planned additive extension (not yet shipped)

The following optional fields are **deferred to a non-breaking additive fast-follow** (epic E15 Out of
scope). They are recorded here so the Python port knows they are coming and can leave room for them,
but they are **not yet shipped in either language** — do not implement them as part of the initial
port:

- `funnel` — an optional median conversion time per step (TS `medianConversionTime` /
  Python `median_conversion_time`).
- `trend` — an optional aggregated series total (TS `aggregated` / Python `aggregated`).

Both land as new **optional** fields on the existing rows (zero migration, never breaking) in their
own later additive query epic, once specced. Until then, treat this row contract as the complete
shipped surface.
