---
id: E2-S5-consent-gating
epic: E2-CORE-provider-seam
status: ready-for-dev
area: core
touches: []
depends_on: [E2-S3-analytics-provider-facade, E2-S4-factory-and-noop-adapter]
api_impact: additive
---

# E2-S5-consent-gating — Consent trio + opt-out routes to the whole-stack no-op

## Why

Consent has no single owner across epics — it must be decided at the seam so it holds identically for every adapter (a vendor-neutral guarantee, like the allowlist). Deciding "opt-out ⇒ whole-stack no-op / memory" here, alongside the null adapter, prevents an unkeyed-or-opted-out client from still leaking captures or writing cookies.

## Scope

### In

- Augment the `AnalyticsProvider` type (S3) with the consent trio: `optIn(): void` · `optOut(): void` · `hasOptedOut(): boolean`.
- Implement the trio on the facade class: an in-memory opted-out state (E2), plus the routing rule — **when opted-out, the facade routes the whole stack to the `NoopAdapter`** (S4), so `capture`/`identify`/`group`/`alias` emit nothing and identity/persistence/session take the memory/no-op path. `optIn()` restores delegation to the live adapter; `hasOptedOut()` reflects current state.

### Out

- **Persisting** the opt-out decision (and the memory-persistence half of the whole-stack reach) — **E4**. E2 keeps opted-out state in memory and fixes the *routing reach*; E4 makes it survive reloads.
- Consent *defaults* wiring from config (opt-out-by-default vs opt-in-by-default) — a config concern that firms up with the persistence layer (E4); E2 ships the trio + routing, not a default policy.
- The optional `flags?`/`replay?` slots — **S6** (note: S6 also extends the `AnalyticsProvider` type — see Technical notes on ordering).

## Acceptance criteria

- [ ] `AnalyticsProvider` now carries `optIn`/`optOut`/`hasOptedOut`; the facade class implements them.
- [ ] With a **live spy adapter** wired in, after `optOut()` the spy receives **zero** `capture`/`identify`/`group`/`alias` calls; `hasOptedOut()` returns `true`.
- [ ] After `optIn()`, delegation to the live adapter resumes; `hasOptedOut()` returns `false`.
- [ ] The opt-out reach is **whole-stack**: an opted-out client performs no persistence write (verified against the SPI's `setPersistedProperty` on the live adapter — it is not called while opted-out).
- [ ] No `disabled` boolean is introduced — opt-out reuses the `NoopAdapter` routing, consistent with S4.
- [ ] `pnpm --filter analytics-kit typecheck`, `lint`, `test`, `build` all exit 0.
- [ ] `grep -ri posthog packages/analytics-kit/src` is clean.

## Technical notes

- **Consent decided at the seam (— architect 2026-07-07, E-cross):** consent has no single owner across epics — decide "opt-out ⇒ whole-stack no-op / memory" HERE alongside the null adapter; E4 implements the persistence half. Same whole-stack reach as the unkeyed no-op (E2↔E4 coupling): an opted-out (or unkeyed) browser client must **not** still write cookies.
- **Reuse the `NoopAdapter` routing (S4), not a flag:** the mechanism is "route the whole stack to the `NoopAdapter` while opted-out" — the same whole-stack null-object S4 builds. This keeps a single no-op path and avoids `if (optedOut)` checks spreading through the facade.
- **In-memory state in E2:** `hasOptedOut()` reads an in-memory flag; E4 persists it (survives reloads) and wires memory-mode persistence. Do not build persistence here.
- **Routing mechanism (where the no-op comes from):** the facade retains its **live** adapter reference and, while opted-out, delegates the verb calls (`capture`/`identify`/`group`/`alias`, plus persistence/identity) to a `NoopAdapter` instance (S4, imported within the seam — S5 has S4 available; S3 did not). `optIn()` restores delegation to the retained live reference. This is exactly the reassignable-adapter field S3 was told to keep swappable — flip the active delegate, don't scatter `if (optedOut)`.
- **The whole-stack persistence-write AC is a FORWARD guard, not a reason to build persistence:** in E2 the facade writes **no** persistence at all (identity/persistence is E4) — so "opted-out ⇒ `setPersistedProperty` not called on the live adapter" is trivially true in both states. Prove the whole-stack reach in E2 via the verb assertions (capture/identify/group/alias routed to the `NoopAdapter` emit nothing on the live spy). The `setPersistedProperty` assertion is a **structural forward-guarantee**: E4 adds real persistence writes and they are already covered because opt-out swaps the entire adapter. Do **not** add persistence logic to the facade here just to make that assertion non-vacuous — that is E4 scope.
- **Ordering vs S6 (both extend `AnalyticsProvider`):** S5 and S6 each add to the `AnalyticsProvider` type — S5 the consent trio, S6 the optional `flags?`/`replay?` slots. Under `/implement-epics` topo order (S5 before S6 by number), S6 extends the type S5 leaves; if both are open at once, coordinate the two additions so neither clobbers the other. No hard dependency between them — both depend on S3.
- **Contrast with PostHog:** PostHog's opt-out gates capture inside its one class; our seam routes to a whole-stack null-object instead, so the guarantee is structural (an opted-out facade *cannot* reach a live adapter) rather than a scattered conditional.

## Shipped
