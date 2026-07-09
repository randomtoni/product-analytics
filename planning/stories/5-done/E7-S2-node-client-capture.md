---
id: E7-S2-node-client-capture
epic: E7-NODE-server-capture
status: ready-for-dev
area: node
touches: []
depends_on: [E7-S1-hoist-allowlist-guard]
api_impact: additive
---

# E7-S2-node-client-capture — Node client skeleton + neutral server capture

## Why

The first server-side target: a standalone `@analytics-kit/node` client with the BRIEF §6 server surface, minting server-truth events keyed on a caller-supplied distinct id. This is the skeleton every later node story hangs off — the client class, the taxonomy-typed `capture(id, event, props, { dedupeId })`, and the server-side allowlist gate. It routes a captured event into an internal `NeutralEvent`, gated by the SAME privacy contract as the browser.

## Scope

### In

- Build out `packages/node/src/` (replace the `index.ts` stub) with a standalone `NodeAnalytics` client class (name by role, never a vendor) exposing the BRIEF §6 surface skeleton: `capture(id, event, props?, options?)`, plus stubs/placeholders for `flush()` / `shutdown()` (real bodies land in E7-S6) so the surface type-checks. `setTraits` / `setGroupTraits` land in E7-S5.
- `capture(distinctId, event, props?, { dedupeId }?)`: `distinctId` REQUIRED per call (no persisted anonymous identity server-side); `event` the neutral name; `props` the neutral properties; a 4th options bag carrying an optional caller-suppliable `dedupeId`.
- Taxonomy typing reused from the seam: type the public `capture` (and later trait verbs) off the seam's `defineTaxonomy<T>()` / `ShapeOf` / `PropsParam` type utilities (imported from `analytics-kit`), mirroring how the seam types `track`. A config-supplied `taxonomy` gives the consumer full type-safety; the library ships zero event names. **Depends on E7-S1 exporting `PropsParam`** (see Technical notes — `PropsParam` is defined in the seam's `taxonomy.ts` but is NOT currently exported from the package entrypoint; S1 adds that export).
- Server-side allowlist enforcement: run the E7-S1 hoisted guard on `props` (and later traits) BEFORE the event is minted — an off-list key fails loudly server-side (throw / drop-and-error-log per config `onViolation`), identical to the browser.
- Map the neutral call into an internal `NeutralEvent` (the seam type): stamp `distinctId`, `event`, `properties`, `timestamp` (`new Date()` at capture), and `dedupeId` — using the caller-supplied `dedupeId` when present, else minting one so `NeutralEvent.dedupeId: string` is always populated and an un-keyed server event still dedupes on retry. **Mint the fallback with node's own `crypto.randomUUID()` (`import { randomUUID } from 'node:crypto'`)** — mirrors the *approach* of the browser factory's `cryptoRandomId` (`crypto.randomUUID()`), but node does NOT import the seam's `generateUuid` (it is an internal seam util, NOT exported from `analytics-kit`) and does NOT reach into `@analytics-kit/browser`. Node ignores `NeutralEvent`'s browser-only fields (`isPageView`/`sessionId`/`enrichmentProfile` stay unset). Hand the `NeutralEvent` to the (E7-S3) enqueue seam — in this story, a minimal in-memory hand-off / buffer stub is fine; real batching is E7-S3.
- A `NodeAnalyticsConfig` shape: `key?`, `taxonomy?`, `allowlist?`, `onViolation?`, `ingestHost?`, `ingestPath?`, and a `fetch?` injection point (the transport primitive) — plus the batching knobs consumed by E7-S3 (`flushAt?` / `flushInterval?` / `maxBatchSize?` / `maxQueueSize?`) and the `shutdownTimeoutMs?` consumed by E7-S6. A config-selected factory (`createAnalytics(config)` in `packages/node/src/create-analytics.ts`, mirroring browser) resolves the client.
- **Package infra:** add `@types/node` as a **devDependency** of `packages/node` (mirrors posthog-js's own node SDK — `posthog-js/packages/node/package.json:52`; runtime deps stay just `analytics-kit`). It types the node globals this epic uses (`fetch`, `Buffer`, `process`, `setTimeout`'s `NodeJS.Timeout` return) for `tsc --noEmit`. Do NOT rely on transitive/hoisted resolution of the root `@types/node` — declaring it explicitly is what keeps the package's typecheck honest under pnpm strict isolation. The node `tsconfig.json` already inherits `lib: ["ES2022"]` (no DOM) from `tsconfig.base.json` — leave it; do NOT add `"DOM"` (node has no `document`/`navigator`/`localStorage`). If any node-global still fails to resolve after adding `@types/node`, add `"types": ["node"]` to the node tsconfig's `compilerOptions` rather than widening `lib`.

### Out

- The real batch queue / defaults / overflow (E7-S3).
- Batch delivery, gzip, wire envelope, node wire-mapper, 413-halving (E7-S4).
- `setTraits` / `setGroupTraits` (E7-S5).
- No-op-without-key wiring + real `flush()`/`shutdown()` bodies (E7-S6). A skeleton that compiles is enough here.
- Any browser concern: no persistence (cookie/localStorage), no session id, no beacon/unload, no enrichment, no autocapture. Node ignores `NeutralEvent`'s browser-only fields (`isPageView`/`sessionId`/`enrichmentProfile`).
- Feature-flag evaluation, alias, reset, consent verbs — not on the node R1 surface.

## Acceptance criteria

- [ ] `@analytics-kit/node` exports a `NodeAnalytics` client (via a `createAnalytics` factory) with `capture(distinctId, event, props?, { dedupeId }?)` where `distinctId` is a required first arg.
- [ ] `capture` is taxonomy-typed off the seam's `defineTaxonomy<T>()` — a consumer-declared event + props type-check; `props` for an event with no declared props is optional (mirrors `PropsParam`).
- [ ] An off-list `props` key fails loudly server-side through the E7-S1 hoisted guard (throw or drop-and-error-log per `onViolation`) — SAME privacy contract as the browser (bar A). Nothing off-list is minted into the `NeutralEvent`.
- [ ] A capture with no caller `dedupeId` still produces a `NeutralEvent` with a populated `dedupeId`; a capture WITH a caller `dedupeId` carries that exact value onto the `NeutralEvent.dedupeId` (idempotency substrate for E7-S4).
- [ ] The public surface names no vendor and no wire vocabulary: no `uuid`, no `$`-prefixed / `ph_` keys, no vendor endpoint/hostname (endpoint is config-supplied). Provider-swap holds for the server target (bar A).
- [ ] Zero browser coupling: node imports nothing from `@analytics-kit/browser`; no cookie/localStorage/session/beacon. The `NeutralEvent` minted server-side leaves `isPageView`/`sessionId`/`enrichmentProfile` unset (browser-only fields).
- [ ] A separate compile-time pin freezes the `NodeAnalytics` surface (its own `keyof` pin), and the seam's 15-member `keyof AnalyticsProvider` pin (`analytics-provider.test.ts:628`) stays green and untouched.
- [ ] All four gates green.

## Technical notes

- Shape (A) — architect (2026-07-08): node is a STANDALONE client, NOT an `AnalyticsAdapter` and NOT driven by `AnalyticsProviderImpl` (its surface is narrower/different from the frozen-15 `AnalyticsProvider` — track/page/reset/consent are absent server-side; `distinctId` is per-call, not persisted). Node reuses the seam ONLY for the taxonomy type utilities and the E7-S1 hoisted allowlist guard. Do NOT make node's `capture` conform to the provider's `track` signature — node ships its own typed-signature layer. This mirrors posthog-js `PostHogBackendClient` (`posthog-js/packages/node/src/client.ts:125`), its own class over a stateless core.
- **Seam imports — verified availability:** `defineTaxonomy` (value), `ShapeOf` / `TaxonomyShape` / `DefaultTaxonomyShape` / `Taxonomy` / `TaxonomyDecl` (types) ARE exported from `analytics-kit` today. `PropsParam` (`taxonomy.ts:67`) and `EmptyObject` (`taxonomy.ts:65`, module-private) are NOT exported. **E7-S1 adds the `PropsParam` export** (a piggybacked one-liner) for downstream reuse, but the chosen `capture` signature below (overloads) does NOT actually need `PropsParam` — it uses `TX['events'][K]` directly plus a node-local `type EmptyObject = {}`. Build S1 before S2 regardless (the hoisted guard is a hard dep). Node builds its OWN client interface — it does NOT extend `AnalyticsProvider`.
- **`capture` signature — SETTLED (overload pair)** — architect (2026-07-08): a single `...args: PropsParam<P>` variadic CANNOT carry a trailing options bag (a rest param must be last), and folding options into the props tuple silently swallows a `{ dedupeId }` into the props slot for no-props events. Use a two-overload pair instead — props-bearing FIRST, no-props (via a `never`-narrowed event) SECOND, each with a trailing `options?`:
  ```ts
  type CaptureOptions = { dedupeId?: string };
  type EmptyObject = {}; // node-local (seam's EmptyObject is module-private)
  interface NodeCapture<TX extends TaxonomyShape> {
    <K extends keyof TX['events'] & string>(
      distinctId: string, event: K, props: TX['events'][K], options?: CaptureOptions
    ): void;
    <K extends keyof TX['events'] & string>(
      distinctId: string, event: EmptyObject extends TX['events'][K] ? K : never, options?: CaptureOptions
    ): void;
  }
  ```
  Overload ORDER matters (props-first, then no-props) so a required-props call can't slip through the no-props overload. The impl signature is the widened `capture(distinctId: string, event: string, propsOrOptions?: object, options?: CaptureOptions)` with the body branching on arg-3 shape. This preserves taxonomy props-enforcement AND a first-class trailing `dedupeId` seat (future `timestamp` tenant). Deliberate asymmetry with browser `track` (which CAN use the clean single-variadic because it has no trailing arg).
- **Frozen-15 pin held:** node adds NO verbs to `AnalyticsProvider` (the 15-member `keyof AnalyticsProvider` pin at `analytics-provider.test.ts:628` is untouched). Its surface is a separate, narrower client interface. Add a SEPARATE compile-time pin over the `NodeAnalytics` surface (mirror the `expectTypeOf<keyof ...>()` pattern) so node's own surface is frozen independently — the epic's "NodeAnalytics has its OWN pin, doesn't touch the 15" requirement.
- **`dedupeId` seat** — architect (2026-07-08): the caller-suppliable `dedupeId` sits in a 4th OPTIONS bag (`capture(id, event, props, { dedupeId })`), not a 4th positional primitive — it's optional and the bag is the extensible seat (a future per-call `timestamp` override for backfill is the obvious next tenant). It stays NEUTRAL: `dedupeId` is the already-agreed neutral field name (`NeutralEvent.dedupeId`, and REFERENCE-BACKEND.md lists it among the two neutral commitments). The `dedupeId → wire uuid` mapping is a WIRE concern that lives entirely in the node wire-mapper (E7-S4), never on this signature. Same neutral name as the browser; different provenance (browser mints, server caller supplies).
- **`distinctId` required, no throwaway path** — posthog-source-guide (2026-07-08): PostHog's node types mark `distinctId` optional only to support an async-context fallback that mints a throwaway uuid + `$process_person_profile=false`. R1 does NOT port that — BRIEF §6 says server capture is "keyed on the same distinct id"; the server always knows who it acts for. Make `distinctId` a required first arg. No persisted anonymous device id server-side.
- **Ported base** — de-brand posthog-js `packages/node/src/client.ts` (public `capture`) + `packages/core/src/posthog-core-stateless.ts` (the stateless enqueue base). Keep the neutral `capture(id, event, props)` signature; map it to the internal `NeutralEvent` INSIDE the client — don't re-plumb node internals with positional args. `$set`/`$set_once`/`$groups`/`$`-anything are PostHog wire vocabulary — they stay behind the E7-S4 wire-mapper, never on this surface.
- **Config-selected factory** mirrors the browser (`packages/browser/src/create-analytics.ts`): `createAnalytics(config)` resolves the client; overloads give taxonomy-typed vs default returns. The unkeyed⇒no-op resolution lands in E7-S6 (skeleton here can construct the real client).
- api_impact additive: a brand-new package surface.

## Shipped
- > Reviewer suggestion (2026-07-08, improvement-pass candidate): `ViolationPolicy` is duplicated node-locally (`config.ts`) because it's NOT re-exported from the seam `index.ts` (only from `analytics-provider.ts`). Structural typing means `enforceAllowlist` accepts it, but it's a drift risk (a future third policy diverges silently). Add `ViolationPolicy` to `analytics-kit/src/index.ts`'s `export type {...} from './analytics-provider'` block, then `config.ts` imports it. (The story's "Also public" note for `ViolationPolicy` was incorrect — E7-S1 exported `PropsParam` but not `ViolationPolicy`.)
- > Reviewer suggestion (2026-07-08, for S3): `EventBuffer.drain()` is on the concrete `InMemoryEventBuffer` but NOT the `EventBuffer` interface (tests reach it via the concrete class) — S3 should decide whether inspection/drain belongs on the interface the client injects.

## Shipped

> Captured by `implement-epics` on 2026-07-08. First server-side target — `@analytics-kit/node` built out from the stub.

- **Files added (node):** `node-analytics.ts` (`NodeAnalyticsClient<TX>` + own narrow `NodeAnalytics<TX>` interface `capture`/`flush`/`shutdown`; the SETTLED two-overload `NodeCapture` props-first/no-props-second + trailing `CaptureOptions`; `splitArgs` position+taxonomy disambiguation NOT runtime shape-sniff; server allowlist gate via SHARED `enforceAllowlist` before mint; `NeutralEvent` mint with `node:crypto` `randomUUID()` dedupeId fallback), `create-analytics.ts` (config-selected factory, taxonomy-typed/default overloads), `config.ts` (`NodeAnalyticsConfig` key/taxonomy/allowlist/onViolation/ingestHost/ingestPath/fetch + S3 batching knobs + S6 `shutdownTimeoutMs`; `FetchLike`; node-local `ViolationPolicy`), `event-buffer.ts` (`EventBuffer` + `InMemoryEventBuffer` hand-off stub)
- **Files changed:** `index.ts` (exports `createAnalytics`+`NodeAnalytics`/`NodeCapture`/`CaptureOptions`/`NodeAnalyticsConfig`/`FetchLike`), `package.json` (+`@types/node ^20` DEVdep; runtime deps stay `analytics-kit`), `pnpm-lock.yaml`; deleted `index.test.ts` stub
- **New public API:** `@analytics-kit/node` `createAnalytics(config)` → `NodeAnalytics<TX>` with `capture(distinctId, event, props?, {dedupeId}?)` (required `distinctId`, no throwaway path). Standalone client — NOT `AnalyticsProvider`/`AnalyticsAdapter`. Own `keyof` pin; seam-15 UNTOUCHED. No vendor/wire vocab (no `uuid`/`$`/`api_key`; config-supplied endpoint).
- **Tests added:** node +18 (runtime 16: props/no-props mint, distinctId verbatim, dedupeId mint-distinct + caller-verbatim both forms, off-list throw + drop nothing-minted, explicit-allowlist, undefined-allowlist, browser-fields-unset, no-browser-import, flush/shutdown resolve; typing 2: taxonomy `@ts-expect-error` pins + separate NodeAnalytics surface pin); seam 166 unchanged
- **Commit:** `E7-S2-node-client-capture — Node client skeleton + neutral server capture` on `core-cycle`
- **Reviewer notes:** 0 critical, 2 suggestions (ViolationPolicy seam re-export; EventBuffer.drain interface)
- **Cross-story seams exposed:** **S3** replaces `InMemoryEventBuffer` with the real queue (batching knobs already on config, unconsumed; client hands one `NeutralEvent` per `capture` via `buffer.add`). **S4** consumes `NeutralEvent[]` via `drain()` → node wire-mapper (`dedupeId`→top-level `uuid`) → gzip `{api_key, batch, sent_at}` → POST config `ingestHost`+`ingestPath` via injected `config.fetch` (`FetchLike`); 413-halving+retry live here. **S5** adds `setTraits`/`setGroupTraits` (taxonomy-typed, gated via same `enforceAllowlist`, routed through buffer) — will GROW the `keyof NodeAnalytics` pin (deliberately separate from seam-15). **S6** unkeyed→no-op in `create-analytics.ts` (currently constructs real client unconditionally) + real `flush()`/`shutdown(shutdownTimeoutMs)` bodies.

## Follow-up

> E7 post-close improvement pass, 2026-07-08 (commit follows). Reviewer-verified, no regression (seam 166 / node 122 green).

- **`ViolationPolicy` single-sourced** — added it to `analytics-kit/src/index.ts`'s type-export block; `config.ts` now imports it from `analytics-kit` and DROPPED the node-local copy. Kills the drift risk; the 15-pin held (additive type export, not a facade member). (Addresses the S2 reviewer suggestion.)
