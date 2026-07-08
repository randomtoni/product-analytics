---
id: E2-S1-neutral-event-substrate
epic: E2-CORE-provider-seam
status: ready-for-dev
area: core
touches: []
depends_on: []
api_impact: additive
---

# E2-S1-neutral-event-substrate — Neutral event object + shared neutral data types

## Why

Every other E2 story references the neutral event shape — the SPI's `capture` verb takes it, the facade constructs it, and browser (E5) / node (E7) idempotency both key on its dedupe field. Fixing this substrate first (and settling the per-event dedupe name once) is what keeps the seam's data contract from diverging across targets.

## Scope

### In

- `NeutralEvent` type in the seam (`packages/analytics-kit/src/`):
  ```ts
  interface NeutralEvent {
    event: string;               // the event name (consumer's taxonomy supplies values)
    distinctId: string;          // required; resolved ABOVE the adapter (E4 browser / E7 node)
    properties?: NeutralProperties;
    timestamp?: Date;            // per-event client event-time
    dedupeId: string;            // settled neutral name — maps to wire top-level `uuid`
    sessionId?: string;          // optional; browser-only, populated in E4; node leaves undefined
  }
  ```
- `NeutralProperties` = `Record<string, unknown>` — an event's properties cross the seam as a plain JSON object; no wire/column layout assumed.
- A `NeutralTraits` alias (= `NeutralProperties`) for the identify/group/trait paths to reuse, so the facade and SPI stories share one trait shape.
- Export these from the seam's public surface (they are the shared substrate the SPI and facade build on).

### Out

- The `AnalyticsAdapter` SPI (S2), the facade (S3), the factory / `NoopAdapter` (S4).
- Any identity/session **population** (E4) — this story only fixes the field *shape*; `distinctId`/`sessionId` values are E4/E7's job.
- Feature-flag / session-replay port types (S6).
- Wire mapping of `dedupeId` → `uuid` — adapter-internal (E5/E7); this story only fixes the neutral field name.

## Acceptance criteria

- [ ] `NeutralEvent`, `NeutralProperties`, `NeutralTraits` are declared in the seam package and exported from its public entry.
- [ ] `distinctId` is a **required** field on `NeutralEvent`; `sessionId` is optional.
- [ ] The per-event dedupe field is named exactly `dedupeId` (not `insertId`, not `$insert_id`, not `uuid`).
- [ ] `properties` is typed as a plain `Record<string, unknown>` — no `$`-prefixed keys, no vendor-shaped nesting baked into the type.
- [ ] `pnpm --filter analytics-kit typecheck`, `lint`, `test`, `build` all exit 0.
- [ ] `grep -ri posthog packages/analytics-kit/src` is clean (no vendor token in type names, field names, or comments).

## Technical notes

- **`distinctId` required, resolved above the adapter (— architect 2026-07-07):** an anonymous distinct id is still a real id, so the field is always conceptually present — requiring it now means no adapter is ever written against an event that might lack an id, and tightening `optional → required` later would be the breaking change. The *value* becomes real in E4 (browser, from persistence) / E7 (node, from the caller's arg); E2 only fixes the field. Reference for the top-level-sibling placement of the id: `posthog-js/packages/core/src/posthog-core-stateless.ts:394-410` (`buildPayload` puts `distinct_id` as a sibling of `event`/`properties`, never inside `properties`) — de-brand `distinct_id` → `distinctId`.
- **`dedupeId` is the settled neutral name (epic Notes, 2026-07-07):** maps to the wire top-level `uuid`, **never** `$insert_id` (`posthog-js/packages/core/src/utils/index.ts:20`). Fixing it here prevents cross-target idempotency divergence — E5 (browser) and E7 (node) both key on `dedupeId`. The `dedupeId → uuid` wire mapping is adapter-internal `[WIRE]`, not a neutral commitment.
- **`sessionId` optional (— architect 2026-07-07):** session is a browser-substrate concept (E4 mints it); node events legitimately have no session, so the field must be optional or node can't satisfy the type. Declared now (empty in E2, populated E4) so E4/E5/E6 are pure population, never reshape.
- **Properties are a plain JSON object** (`posthog-js/packages/core/src/types.ts:938`) — no wire contract may assume a backend column layout. Keep `NeutralProperties` a flat `Record<string, unknown>`.
- Keep this story types-only — no runtime construction logic (that lands in the facade, S3). The `NeutralEvent` shape is the frozen contract these stories agree on.
- **Public-surface plumbing (E1 shipped shape):** the seam's only tsup entry + only export barrel is `src/index.ts` (E1-S2 shipped the exports triplet with **no `"type":"module"`**; `include:["src"]`). Put these types in their own module (e.g. `src/neutral-event.ts`) and **re-export them through `src/index.ts`** — a type that isn't reachable from `index.ts` won't appear in the build or the emitted `.d.ts`. Under `moduleResolution: Bundler`, intra-package relative imports take **no** `.js` extension (`from './neutral-event'`, not `'./neutral-event.js'`). This plumbing convention holds for every E2 story that adds a public type.

## Shipped
