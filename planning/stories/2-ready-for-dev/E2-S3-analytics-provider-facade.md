---
id: E2-S3-analytics-provider-facade
epic: E2-CORE-provider-seam
status: ready-for-dev
area: core
touches: []
depends_on: [E2-S1-neutral-event-substrate, E2-S2-analytics-adapter-spi]
api_impact: additive
---

# E2-S3-analytics-provider-facade — `AnalyticsProvider` facade (the §1 consumer surface, delegating)

## Why

The `AnalyticsProvider` facade is the contract consumers code against — the backend-agnostic surface that holds an adapter and delegates. It is the other half of bar A (one facade, many adapters) and the anchor every downstream area (identity, capture, query) plugs into.

## Scope

### In

- `AnalyticsProvider` **type** in the seam (`packages/analytics-kit/src/`) exposing the BRIEF §1 surface **minus the consent trio** (consent is S5):
  - `track(event: string, props?: NeutralProperties): void`
  - `identify(id: string, traits?: NeutralTraits, traitsOnce?: NeutralTraits): void`
  - `page(name?: string, props?: NeutralProperties): void`
  - `group(type: string, key: string, props?: NeutralTraits): void`
  - `reset(): void`
  - `setTraits(traits: NeutralTraits, once?: boolean): void`
  - `flush(): Promise<void>`
  - `shutdown(): Promise<void>`
- A thin facade **class** implementing that type: it holds an `AnalyticsAdapter` and delegates. The mapping (see Technical notes):
  - `track` / `page` → construct a `NeutralEvent` (name + properties + `timestamp` + a generated `dedupeId` + `distinctId` stub) and call `adapter.capture(event)`.
  - `identify` → `adapter.identify(id, traits, traitsOnce)`; `group` → `adapter.group(type, key, props)`; `setTraits` → `adapter.identify` trait-update path.
  - `flush` → `adapter.flush()`; `shutdown` → `adapter.shutdown()`.
- Export `AnalyticsProvider` from the seam's public surface (this name is deliberately kept — see Technical notes on the E9 collision).

### Out

- The consent trio `optIn`/`optOut`/`hasOptedOut` and opt-out routing — **S5** augments this type.
- The `createAnalytics` factory and `NoopAdapter` — **S4** (S3 delivers the facade shape; S4 wires it to an adapter and exercises it).
- Optional `flags?`/`replay?` slots — **S6**.
- Real identity/session behavior behind `reset()` and the identity-write half of `setTraits()` — **E4** (see Technical notes); E2 provides the delegation skeleton only.
- Taxonomy typing on `track`/`group`/`page` and the allowlist guard — **E3** (the facade owns the hook seam; E3 fills it).

## Acceptance criteria

- [ ] `AnalyticsProvider` is declared and exported with exactly the eight §1 methods above (no consent trio yet).
- [ ] The facade class holds an `AnalyticsAdapter` (S2) and delegates; it constructs the `NeutralEvent` for `track`/`page` and never touches wire shapes.
- [ ] `track`/`page` stamp a `timestamp` and a generated `dedupeId` on the neutral event; `distinctId` is populated (a stub/anonymous placeholder in E2 — real value is E4).
- [ ] The facade is backend-agnostic: it contains no transport, batching, persistence, or vendor logic — those live below the adapter.
- [ ] Delegation is unit-testable against a mock/spy adapter (never a real backend): e.g. `track('x', {a:1})` results in exactly one `adapter.capture` call carrying a `NeutralEvent` with `event: 'x'`.
- [ ] `pnpm --filter analytics-kit typecheck`, `lint`, `test`, `build` all exit 0.
- [ ] `grep -ri posthog packages/analytics-kit/src` is clean.

## Technical notes

- **Two objects, one boundary (— architect 2026-07-07):** `AnalyticsProvider` (facade) owns everything backend-agnostic (later: taxonomy typing, allowlist guard, consent gating, neutral-event construction), holds an adapter, and delegates; `AnalyticsAdapter` (S2) is the minimal contract a backend satisfies. The facade is **thin** — the port lands in the adapter.
- **Interface vs. class — pin this so S4/S5/S6 don't drift:** `AnalyticsProvider` is the **exported interface** (the consumer-facing contract type; this is the name that gets kept per the E9 note). The implementing facade is an **internal class** — declared in its own module (e.g. `src/analytics-provider.ts`) and **NOT re-exported from `src/index.ts`**. Consumers never `new` it; they obtain an `AnalyticsProvider` only via `createAnalytics` (S4). S4 instantiates this internal class; S5 (consent) and S6 (`flags?`/`replay?`) each **augment the same interface AND edit this same internal class in place**. Pick a stable internal name now (e.g. `AnalyticsProviderImpl`) and reference it consistently — it's internal, so the choice never touches the public API, but S4/S5/S6 all key on it.
- **Constructor injection (S4/S5 depend on this):** the facade class takes its `AnalyticsAdapter` via the **constructor** and holds it in a **reassignable** field — not a `readonly`/frozen binding. S4's factory injects the resolved adapter (supplied-or-`NoopAdapter`); S5's opt-out routing needs to swap the active delegate to a `NoopAdapter` and swap it back on `optIn`. A `readonly` adapter field would force S5 to refactor the facade — keep it swappable from the start.
- **Method → SPI verb mapping (pin this):** `track`→`capture`, `page`→`capture` (a page is a captured event with reserved page semantics; the reserved page-slot typing is E3, page context/enrichment is E6), `identify`→`identify`, `group`→`group`, `setTraits`→ the `identify` trait-update path, `flush`→`flush`, `shutdown`→`shutdown`. There is **no** SPI `reset` verb: `reset()` is an identity/persistence concern — in E2 it is a declared delegation skeleton whose real behavior (clear identity + regenerate anon id) lands in **E4**. Likewise the identity-write half of `setTraits` completes in E4; E2 wires the delegation only.
- **`dedupeId` generation:** the facade generates a `dedupeId` per event (the neutral name settled in S1). Keep the generator a simple UUID for E2; the wire mapping to top-level `uuid` is adapter-internal (E5/E7).
- **`page()` still constructs a valid `NeutralEvent` — with a NEUTRAL name:** `NeutralEvent.event` (S1) is a **required** `string`, but `page(name?, …)` takes an optional name. When `name` is omitted, the facade must supply a fallback event name. Use a **neutral** placeholder constant (never a `$`-prefixed vendor token like `$pageview` — that would bake a vendor-shaped reserved name into the seam and defeats the neutrality bar even though the `grep -ri posthog` gate wouldn't catch a `$`-name). The real reserved page-slot **typing/semantics** is E3/E6 — E2 only needs a compiling, neutral placeholder so `page()` produces a well-formed `NeutralEvent`.
- **`distinctId` stub (— architect 2026-07-07):** the facade produces a fully-populated `NeutralEvent` *before* calling `adapter.capture` — in E2, with no identity subsystem yet, stamp a throwaway/anonymous placeholder. E4 replaces the stub with a real identity/session resolver; no `NeutralEvent` reshape, pure population. Do **not** push id resolution down into the adapter.
- **Naming collision — this type KEEPS the name (epic Notes, 2026-07-07):** the facade type `AnalyticsProvider` (this story, `analytics-kit` package) shares its name with E9's React `<AnalyticsProvider>` component (`@analytics-kit/react`). The neutral facade keeps the name; **E9 renames its component** so a consumer can import both without a clash. Name the facade `AnalyticsProvider` here confidently — do not pre-rename it to avoid the collision.
- **Allowlist/taxonomy hook seam (E3):** the facade is where the allowlist guard and typed-taxonomy signatures attach (pre-enrichment, at the call boundary). E2 does not implement them, but keep `track`/`identify`/`group`/`setTraits` structured so E3 can insert the guard at the call boundary without reshaping the facade.

## Shipped
