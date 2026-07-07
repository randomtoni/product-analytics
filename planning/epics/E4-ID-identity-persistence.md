---
id: E4-ID-identity-persistence
status: planned
area: identify
touches: [browser, privacy]
api_impact: additive
blocked_by: [E2-CORE-provider-seam, E3-CORE-taxonomy-allowlist]
updated: 2026-07-07
---

# E4-ID-identity-persistence — Browser identity, persistence & the shared browser substrate

## Why

Every browser event needs a stable actor to attach to before the consumer ever calls `identify()`, and that anonymous identity must survive reloads and stitch across subdomains for pre-login funnels. This is the first target-package epic and the substrate the whole `identify` area is stabilized around; it also lands the persistence layer that the `capture` cycle (E5/E6) builds directly on. Informed by `research/ARCHITECT-RELEASE1.md` §E4 and §E-cross.

## Success criteria

- An anonymous distinct id (UUIDv7) is generated at first load, persisted, and reused across reloads; the neutral surface exposes an explicit `anonymous | identified` state, never the wire id-equality trick.
- Persistence mode is config-selectable (`cookie` | `localStorage+cookie` | `memory`), defaulting to `localStorage+cookie`; the cookie half carries only the small identity/session keys.
- A config-supplied `cookieDomain` is authoritative for cross-subdomain sharing; the public-suffix auto-probe is used only as fallback. A simulated cross-subdomain journey keeps one distinct id.
- `identify(id, traits, traitsOnce)` performs the anonymous→identified merge **client-side only**, and only when the id differs AND the actor is still anonymous; re-identifying with the same id updates traits; an already-identified actor identifying with a new id does not merge.
- `traits` (mutable) and `traitsOnce` (first-touch-immutable) follow register / register_once semantics.
- A session id (UUIDv7) is assigned and expires on idle (30 min default) or max length (24 h default), both configurable; a session id is minted even in memory / consent-declined mode.
- `reset()` regenerates the anonymous id and clears identity + persistence + session, but keeps the device id unless an explicit `resetDevice` flag is passed.
- Consent-declined resolves to a real memory-mode / no-op persistence state (no cookies written), satisfying the whole-stack no-op that E2's factory promises.
- **Bar B:** cookie domain, scope, persistence mode, and consent default are config-only; the library hardcodes none. **Zero vendor references** in storage key names, state names, or the neutral surface.

## Stories

<!-- Tentative slice — story files not yet written. Rewrite as the one-line-per-story map after they land in stories/1-backlog/. -->

- **Shared browser-substrate decomposition spike** — carve the neutral event object + the property-build order + the persistence/storage substrate out of posthog-js's ~4,200-line browser monolith into the neutral facade + adapter seam. MUST be first; E5/E6 build on the same substrate.
- **Persistence store + modes** — port `posthog-persistence.ts` de-branded: `cookie | localStorage+cookie | memory` modes, register / register_once / unregister, save-debounce + unload flush; neutral storage key naming (no `ph_` / `_posthog`).
- **Cross-subdomain cookie domain/scope** — config-supplied `cookieDomain` authoritative; public-suffix auto-probe (`chooseCookieDomain` / `seekFirstNonPublicSubDomain`) as fallback; cookie half mirrors only identity/session keys.
- **Anonymous id + identity state** — UUIDv7 anonymous/device id, explicit `anonymous | identified` state on the neutral surface, pluggable device-id generator.
- **identify() merge + traits/traitsOnce** — client-side anon→identified merge with PostHog's guards; mutable `traits` vs first-touch `traitsOnce`.
- **Session id assignment + expiry** — port `SessionIdManager`: idle 30 min / max 24 h (both configurable), UUIDv7 ids, minted even in memory mode.
- **reset()** — regenerate anonymous id, clear identity/persistence/session, keep device id unless `resetDevice`.
- **Consent persistence** — make consent-declined → memory-mode / no-op state real (E2 owns the `optIn`/`optOut` interface; this wires the persistence half).

## Out of scope

- Batching, retry/backoff, offline-queue persistence, ingest host, dedupe/insert id — `capture` cycle, **E5**.
- Page / UTM / device context enrichment, session-entry props, per-context capture profiles, pageleave — `capture` cycle, **E6** (E6 consumes the session id this epic plumbs).
- The `optIn` / `optOut` / `hasOptedOut` **interface** and the config-selected no-op factory — **E2** (this epic only makes the consent-declined persistence state real).
- Server-side identity merge (identified→identified) — not release 1; PostHog does anon→identified client-side only.
- `group()` typing and event-time super-property application — thread through `defineTaxonomy` (E3) and the capture path (**E6**); `alias` on the SPI is not in this epic's slice.

## Notes

- **First story is the shared-decomposition spike, not an identity feature.** — architect (2026-07-07): posthog-js's browser core is one ~4,200-line monolith (`posthog-core.ts`) and E4/E5/E6 all slice the SAME file; the real cost is de-branding/de-coupling it into the neutral facade + adapter, not the per-feature logic. Front-load the E4/E5/E6 shared substrate (neutral event object + property-build order + persistence layer) before the tracks split.
- **Default persistence is `localStorage+cookie`, not pure cookie.** — architect (2026-07-07): PostHog abandoned the pure-cookie default (~4 KB cap); the cookie half carries only identity/session keys for cross-subdomain sharing, localStorage holds the bulk. The BRIEF's "cookie default" is satisfied by the cookie-backed identity keys — this is a PM-confirmed default choice, not a technical unknown.
- **Cross-subdomain: explicit `cookieDomain` authoritative, auto-probe is fallback.** — architect (2026-07-07): the eTLD public-suffix probe (throwaway `dmn_chk_*` cookies) is fragile; the consumer supplies the domain per BRIEF, the probe only de-risks the missing-config case.
- **Anonymity is an explicit neutral state; the wire encoding stays in the adapter.** — architect (2026-07-07): the neutral surface carries `anonymous | identified`; the `distinct_id === $device_id` trick, the `$sesid` `[lastActivity, id, start]` tuple, `$anon_distinct_id`, and `ph_`-prefixed names are all [WIRE], normalized inside the browser adapter. No `$`-prefixed names on the neutral surface.
- **identify() merge guards (client-side only).** — architect (2026-07-07): merge only when the new id differs AND the actor is still anonymous; same-id re-identify just updates traits; already-identified + new id does NOT merge client-side. No server-side identity merge this release.
- **Session defaults: idle 30 min, max 24 h, UUIDv7; must mint even in memory mode.** — architect (2026-07-07): sessions are needed by E6 enrichment and transport session-props, so consent-declined/memory mode must still produce a session id or E6 breaks. Sessions are independent of replay (out of scope).
- **reset() keeps the device id by default.** — architect (2026-07-07): regenerate the anonymous id + clear state; regenerate the device id only on an explicit `resetDevice` flag (PostHog's default keeps it).
- **Consent ownership is split E2↔E4 and lands here.** — architect (2026-07-07): `optOut`/`hasOptedOut` (E2 interface) must switch persistence to memory (this epic), so consent has no real effect until E4; decide the null adapter's reach in E2, implement the persistence half here. This is why `privacy` is in `touches`.
- **Consumer traits are gated by E3's facade allowlist before E4 registers them.** — architect (2026-07-07, E3 §3): `identify`/`setTraits` keys are validated at the facade PRE-registration; E4 owns `register`/`register_once` and receives already-gated keys — it does not re-implement the allowlist. Library-computed keys (device/session/context) are trusted, not gated. E3 records the mirror boundary (E3 owns the gate, E4 owns registration).

## Expansion path

- The shared browser substrate this epic carves (neutral event object, property-build order, persistence layer) is the base E5 (transport) and E6 (enrichment/capture) extend — additive, no seam break.
- A future non-PostHog browser adapter reuses the neutral `anonymous | identified` state and the persistence-mode contract unchanged; only the [WIRE] encoding (`$sesid` tuple, id-equality anonymity, cookie key names) is re-implemented behind the adapter.
- Device-id and session-id generators are pluggable, so a consumer or future adapter can swap the id scheme without touching the identity semantics.
