---
id: E4-S8-session-id-expiry
epic: E4-ID-identity-persistence
status: ready-for-dev
area: identify
touches: [browser]
depends_on: [E4-S1-browser-substrate-spike, E4-S2-persistence-store-modes]
api_impact: additive
---

# E4-S8-session-id-expiry — Session id assignment + idle/max expiry, stamped in the capture pipeline

## Why

Events group into sessions, and E6 enrichment + transport session-props consume the session id — so it must exist (even in memory mode) before E6. This ports the session-id manager with idle + max-length expiry and stamps `NeutralEvent.sessionId` in the browser adapter's capture pipeline.

## Scope

### In

- Port `SessionIdManager` de-branded: a UUIDv7 session id assigned and expiring on idle (30 min default) OR max length (24 h default), both config-selectable (`AnalyticsConfig` additive fields, e.g. `sessionIdleTimeoutMs?` / `sessionMaxLengthMs?`).
- The browser adapter stamps `NeutralEvent.sessionId` as the FIRST step of its capture pipeline (the facade leaves it undefined). Driven by a stateful `checkAndGetSessionAndWindowId(timestamp)`-style call that advances the idle clock and mints on expiry — behavior, NOT a `getPersistedProperty` read; NO new SPI accessor.
- A session id is minted even in `persistence: 'memory'` mode (mint is independent of storage backing).

### Out

- Session replay — out of scope entirely (sessions are independent of replay).
- Cross-tab session hand-off / activity-persist — explicitly deferred (later hardening).
- Consuming the session id for enrichment / transport session-props — **E6**.

## Acceptance criteria

- [ ] A UUIDv7 session id is assigned and stamped on `NeutralEvent.sessionId` by the browser adapter (the facade still leaves it undefined; the field stays optional).
- [ ] Idle expiry (default 30 min) mints a new session id; max-length expiry (default 24 h) mints a new one; both defaults are config-overridable.
- [ ] Expiry is timestamp-driven (advancing idle from the event timestamp), NOT a plain KV read; no new SPI verb was added for the session id.
- [ ] A session id is minted even with `persistence: 'memory'`.
- [ ] The [WIRE] `$sesid [lastActivity, id, start]` tuple is normalized inside the adapter; no `$`-prefixed name on any neutral surface; grep clean.
- [ ] jsdom tests; both packages' gates green.

## Technical notes

- **Adapter stamps `sessionId`; not an SPI accessor and not `getPersistedProperty` (Q3, — architect 2026-07-08):** the id comes from a stateful `checkAndGetSessionAndWindowId(timestamp)` that advances the idle clock and mints on expiry — behavior, browser-only (node has no sessions). `NeutralEvent.sessionId` is optional precisely because it's adapter-populated. A KV read can't express "give me the current id, advancing idle from this timestamp."
- **Memory-mode nuance (Q3):** "minted even in memory mode" means the REAL browser adapter with `persistence: 'memory'` (mint is independent of storage), NOT the whole-stack `NoopAdapter` (there every event is dropped, so an unset `sessionId` is harmless).
- **Defaults (— architect 2026-07-07):** idle 30 min, max 24 h, UUIDv7; needed by E6, so memory mode must still mint or E6 breaks. Independent of replay.
- **De-brand:** normalize the `$sesid` tuple + key inside the adapter; neutral role-named storage key. Consumes S1's crypto UUIDv7 generator (`crypto.getRandomValues` + `Date.now()` prefix — NOT `crypto.randomUUID`, which is v4; the v7 timestamp is what lets a session-start time be read back out of the id).
- **Expose a session-reset entry point for S9 (refiner 2026-07-08):** S9's `reset()` clears the session. Port the de-branded manager with a public reset/regenerate method (PostHog's `SessionIdManager.resetSessionId()`, `sessionid.ts`) so S9 can call it without reaching into manager internals. Adapter-internal — no SPI / neutral-surface addition.
- reference: `posthog-js/packages/browser/src/sessionid.ts`; de-brand.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->
