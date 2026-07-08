---
id: E2-CORE-provider-seam
status: done
area: core
touches: [adapters]
api_impact: additive
blocked_by: [E1-CORE-workspace-scaffold]
updated: 2026-07-07
---

# E2-CORE-provider-seam — Core seam: provider facade + adapter SPI + config-selected factory

## Why

The `AnalyticsProvider` facade + `AnalyticsAdapter` SPI *is* the vendor-neutral seam — the contract consumers code against and the minimal surface any backend satisfies. It is the load-bearing piece for both acceptance bars (provider-swap = one adapter, zero consumer change; new-app = config only), and everything downstream (identity, transport, capture, query) plugs into this boundary.

## Success criteria

- `AnalyticsProvider` facade exposes the BRIEF §1 surface: `track` · `identify(id, traits, traitsOnce)` · `page(name?, props?)` · `group(type, key, props)` · `reset()` · `setTraits(traits, once?)` · `optIn` / `optOut` / `hasOptedOut` · `flush` / `shutdown`.
- `AnalyticsAdapter` SPI defined as the minimal neutral contract: transport (`fetch`), persisted-property storage (get/set), client identity (id / version / user-agent), and neutral capture/identify/group/alias + flush/shutdown taking **neutral event objects**. No `$`-names, no `/batch/` envelope on the SPI.
- A neutral event object type is defined in the seam and carries the settled per-event **dedupe/insert-id** field — fixed here (maps to the wire top-level `uuid`, never `$insert_id`) so browser (E5) and node (E7) idempotency use the same neutral name.
- `createAnalytics(config)` selects the adapter from config and returns a facade wired to it; when no key is configured it returns a **whole-stack `NoopAdapter`** (a silent no-op object, not a `disabled` flag).
- Consent (`optIn`/`optOut`/`hasOptedOut`) lives on the facade; opt-out routes to the whole-stack no-op / memory path (persistence half implemented in E4).
- `FeatureFlagPort` / `SessionReplayPort` declared as optional capability slots (typed extension points), `undefined` in release 1 — zero flag/replay logic shipped.

## Stories

Six stories, **all shipped**. Dependency shape (topo-sortable via `depends_on`):

```
S1 ─► S2 ─► S3 ─┬─► S4 ─► S5
                └─► S6
```

- **[E2-S1](../stories/5-done/E2-S1-neutral-event-substrate.md)** *(done — `fa6c6b5`)* — the `NeutralEvent` type + shared neutral data types (`NeutralProperties`/`NeutralTraits`); `distinctId` required (resolved above the adapter) + settled per-event `dedupeId` name.
- **[E2-S2](../stories/5-done/E2-S2-analytics-adapter-spi.md)** *(done — `0e4043a`)* — the `AnalyticsAdapter` SPI: neutral verbs (capture/identify/group/alias/flush/shutdown over `NeutralEvent`) + neutral platform primitives (transport `fetch` via DOM-free `NeutralFetch*` types, persisted-property get/set, client identity). No wire terms on the interface.
- **[E2-S3](../stories/5-done/E2-S3-analytics-provider-facade.md)** *(done — `349b102`)* — the `AnalyticsProvider` facade (interface + internal `AnalyticsProviderImpl`): BRIEF §1 surface minus the consent trio, a thin class holding an adapter and delegating. Keeps the `AnalyticsProvider` name.
- **[E2-S4](../stories/5-done/E2-S4-factory-and-noop-adapter.md)** *(done — `3678e8b`)* — `createAnalytics(config, adapter?)` generic factory + whole-stack `NoopAdapter` null-object; unkeyed ⇒ silent. Inward-only preserved (no seam-side target imports).
- **[E2-S5](../stories/5-done/E2-S5-consent-gating.md)** *(done — `ff20866`)* — `optIn`/`optOut`/`hasOptedOut`; opt-out swaps the whole stack to the `NoopAdapter` (in-memory in E2; E4 persists).
- **[E2-S6](../stories/5-done/E2-S6-optional-capability-ports.md)** *(done — `6a5b906`)* — declared-but-unimplemented `FeatureFlagPort` / `SessionReplayPort` optional slots (`flags?`/`replay?`), types only, `undefined` in release 1; separate from `track`/`identify`.

## Out of scope

- Real transport / batching / persistence mechanics — adapter-internal (browser E5, node E7).
- Identity / session persistence (E4); E2 declares consent's no-op *reach*, E4 implements the memory-mode half.
- Taxonomy typing + allowlist enforcement (E3) — the facade owns the hooks; E3 fills them.
- Any feature-flag or session-replay implementation (typed extension points only).

## Notes

- — architect (2026-07-07): Two objects, one boundary — `AnalyticsProvider` (facade, consumer-facing) owns everything backend-agnostic (taxonomy typing, allowlist guard, consent gating, neutral-event construction), holds an adapter, and delegates; `AnalyticsAdapter` (SPI) is the minimal contract a backend satisfies.
- — architect (2026-07-07): SPI shape = the target-agnostic subset of PostHog's `PostHogCoreStateless` — `fetch` transport + `getPersistedProperty`/`setPersistedProperty` storage + `getLibraryId`/`Version`/`CustomUserAgent` client identity (`packages/core/src/posthog-core-stateless.ts:247-254`), which are genuinely neutral. But the SPI's *verbs* are neutral capture/identify/group/alias + flush/shutdown over neutral event objects; the adapter maps them to the wire internally. Do NOT surface PostHog's `enqueue` / `/batch/` envelope or `$`-names on the SPI — those are adapter-internal [WIRE].
- — architect (2026-07-07): Facade is thin; the adapter is where the port lands. Batching/transport/persistence are adapter-internal, not seam concerns — browser and node adapters may legitimately differ in mechanics while satisfying the same neutral SPI (PostHog's own asymmetry: node **extends** the stateless base and reuses its queue at `packages/node/src/client.ts:125`; browser is a **sibling** implementing the interface at `packages/browser/src/posthog-core.ts:389`).
- — architect (2026-07-07): No-op is a whole-stack `NoopAdapter` null-object, NOT a `disabled` boolean threaded through one class (PostHog's `disabled = options.disabled ?? false || missingApiKey`, `packages/core/src/posthog-core-stateless.ts:287`). A null-object keeps `if (disabled)` checks from spreading and makes "unkeyed ⇒ silent" a type-level guarantee. The no-op must be whole-stack — identity/persistence/session also go to memory mode (couples to E4), not just transport.
- — architect (2026-07-07): Feature-flags / session-replay are declared-but-unimplemented optional ports — define the port types in the seam package and hang them off the provider as optional capability slots (`analytics.flags?`, `analytics.replay?`), populated by an adapter only if provided (`undefined` in release 1). Keep them separate ports, never folded into `track`/`identify` (PostHog bundles flags into its one class — we deliberately don't).
- — architect (2026-07-07, E-cross): Consent has no single owner across epics — decide "opt-out ⇒ whole-stack no-op / memory" HERE in E2 alongside the null adapter; E4 implements the persistence half. Same for the no-op's whole-stack reach (E2↔E4 coupling): an unkeyed browser client must not still write cookies.
- — architect (2026-07-07, E-cross): Settle the neutral per-event **dedupe/insert-id** field name in the E2/E3 seam so browser (E5) and node (E7) agree — it maps to the wire top-level `uuid`, NOT `$insert_id` (`packages/core/src/utils/index.ts:20`). Fixing the name here prevents cross-target idempotency divergence.
- Naming collision, flagged for E9 (not resolved here): the facade type `AnalyticsProvider` (this epic, `analytics-kit` package) shares its name with the React binding's provider component, which the memo also sketches as `<AnalyticsProvider>` (`research/ARCHITECT-RELEASE1.md` E9, `@analytics-kit/react` package). The neutral facade keeps the name; E9 owns renaming its component so a consumer can import both without a clash.
- Factory placement vs inward-only deps (reconciled): the seam ships the factory **machinery** — a generic `createAnalytics(config, adapters)` that wires a facade to whichever adapter set it is handed — but the seam package never imports a target adapter (E1's inward-only rule). Each target package exports the consumer-facing config-selected entry (`import { createAnalytics } from "@analytics-kit/browser"`, per README) that passes its own adapters in, falling back to the seam's `NoopAdapter` when unkeyed. "Selects the adapter from config" in the success criterion means this two-piece shape, not seam-side imports of targets. E9's `config`-branch provider builds on the browser package's entry (browser = peer dep of react).
- Confidence: high (facade/SPI split, factory, no-op) · med (exact extension-point signatures — sketch, don't freeze until an adapter needs them).

## Expansion path

A new backend is one new adapter satisfying the same SPI (bar A). The optional capability ports (flags / replay) light up when an adapter implements them — additive, zero facade or consumer change.
