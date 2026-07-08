---
id: E2-S2-analytics-adapter-spi
epic: E2-CORE-provider-seam
status: ready-for-dev
area: core
touches: [adapters]
depends_on: [E2-S1-neutral-event-substrate]
api_impact: additive
---

# E2-S2-analytics-adapter-spi — `AnalyticsAdapter` SPI (the minimal neutral backend contract)

## Why

The `AnalyticsAdapter` SPI is the minimal surface any backend satisfies — it *is* bar A ("provider-swap = one adapter, zero consumer change"). Getting it expressed in capability terms (neutral verbs + neutral platform primitives), never wire terms, is what lets the future self-hosted adapter slot in without SPI churn.

## Scope

### In

- `AnalyticsAdapter` interface in the seam (`packages/analytics-kit/src/`), with two coherent halves:
  - **Neutral verbs** (what the facade delegates):
    - `capture(event: NeutralEvent): void`
    - `identify(distinctId: string, traits?: NeutralTraits, traitsOnce?: NeutralTraits): void`
    - `group(type: string, key: string, traits?: NeutralTraits): void`
    - `alias(previousId: string, distinctId: string): void` — SPI-only (used by E4's merge; **not** a facade method)
    - `flush(): Promise<void>`
    - `shutdown(): Promise<void>`
  - **Neutral platform primitives** (the genuinely-neutral lower-level capabilities a target provides):
    - transport: `fetch(...)` — a neutral transport primitive (adapter maps to the wire internally)
    - persisted-property storage: `getPersistedProperty<T>(key: string): T | undefined` · `setPersistedProperty<T>(key: string, value: T | null): void`
    - client identity: `getLibraryId(): string` · `getLibraryVersion(): string` · `getCustomUserAgent(): string | undefined`
- Export `AnalyticsAdapter` from the seam's public surface.

### Out

- Any concrete adapter — the `NoopAdapter` is S4; real transport/persistence/batching are adapter-internal (browser E5, node E7).
- The facade that delegates to this SPI (S3).
- Wire mapping (`/batch/` envelope, `$`-names, compression, ingest paths) — adapter-internal `[WIRE]`, never on the SPI.
- Freezing **how** the facade resolves identity through `getPersistedProperty` vs. a separate injected identity port — that's an E4 mechanism decision (see Technical notes).

## Acceptance criteria

- [ ] `AnalyticsAdapter` is declared and exported from the seam; its `capture` verb takes a `NeutralEvent` (from S1), not a `distinctId` positional arg.
- [ ] The SPI carries the neutral verbs (capture/identify/group/alias/flush/shutdown) **and** the neutral platform primitives (transport `fetch`, persisted-property get/set, client-identity id/version/user-agent) — no more.
- [ ] No `$`-prefixed names, no `/batch/` envelope, no vendor endpoint, no compression header appears anywhere in the SPI type.
- [ ] `flush`/`shutdown` return `Promise<void>`; the capture-path verbs are fire-and-forget (`void`).
- [ ] `pnpm --filter analytics-kit typecheck`, `lint`, `test`, `build` all exit 0.
- [ ] `grep -ri posthog packages/analytics-kit/src` is clean.

## Technical notes

- **SPI shape = the target-agnostic subset of `PostHogCoreStateless` (epic Notes, 2026-07-07):** `fetch` transport + `getPersistedProperty`/`setPersistedProperty` storage + `getLibraryId`/`getLibraryVersion`/`getCustomUserAgent` client identity are the genuinely-neutral primitives (`posthog-js/packages/core/src/posthog-core-stateless.ts:247-254`) — de-branded. The SPI's **verbs** are neutral capture/identify/group/alias + flush/shutdown; the adapter maps them to the wire internally. Do **not** surface PostHog's `enqueue` / `/batch/` envelope or `$`-names — those are adapter-internal `[WIRE]`.
- **`capture(event: NeutralEvent)`, id rides inside the event (— architect 2026-07-07):** the id is resolved *above* the adapter — the facade produces a fully-populated `NeutralEvent` before calling `adapter.capture(event)`; the adapter never resolves identity in its capture path. This is what keeps the SPI uniform across the browser-stateful / node-stateless split (browser fills `distinctId` from persistence in E4; node fills it from the caller's `capture(id, …)` arg in E7 — same SPI verb, same event type, pure population). PostHog's node *public* surface already uses this object form (`posthog-js/packages/node/src/client.ts:591`, `EventMessage { distinctId, event, properties }`); the positional `captureStateless(distinctId, …)` is its internal base convention — don't lift it to the SPI.
- **`alias` is SPI-only** (— architect 2026-07-07): included so E4's anonymous→identified merge can use it; it is **not** exposed on the facade (BRIEF §1 lists no `alias`). Keep the param shape a minimal sketch here; E4 finalizes it when the merge lands — non-breaking to the epic's SPI shape.
- **Adapter-internal mechanics may differ per target (— architect 2026-07-07):** batching/transport/persistence are below this contract. PostHog's own asymmetry — node **extends** the stateless base (`posthog-js/packages/node/src/client.ts:125`), browser is a **sibling** implementing the interface (`posthog-js/packages/browser/src/posthog-core.ts:389`) — is exactly the freedom the neutral SPI preserves.
- **Do NOT freeze the identity-resolution mechanism (— architect 2026-07-07):** the storage capability (`getPersistedProperty`/`setPersistedProperty`) is on the SPI per the epic's committed contract, but *how the facade uses it to resolve `distinctId`* (through this SPI storage vs. a separately-injected identity port) is an E4 signature detail — sketch, don't freeze. E2 only commits: (1) the storage capability exists on the SPI, (2) `capture` takes a resolved `NeutralEvent`, (3) the adapter receives a resolved id and never resolves one itself.
- **Reference-backend sanity check (REFERENCE-BACKEND.md, 2026-07-07):** the SPI stays expressed in capability terms (capture/identify/query), never wire terms — this is what lets the self-hosted reference adapter slot in without SPI churn. Confirm no wire term leaks onto the interface before closing this story.

## Shipped
