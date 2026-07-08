---
id: E6-S4-utm-campaign-session-entry
epic: E6-CAP-capture-enrichment
status: ready-for-dev
area: capture
touches: [browser]
depends_on: [E6-S3-context-enrichment-port]
api_impact: additive
---

# E6-S4-utm-campaign-session-entry — UTM/campaign parse + set-once attribution

## Why

Campaign attribution (UTM params, click-ids) and the set-once "initial" / session-entry props are how a consumer ties conversions back to acquisition. This adds the parse + the once-per-session / once-per-identity persistence layer on top of the per-event context from E6-S3.

## Scope

### In

- **UTM/campaign parse:** parse `utm_source/medium/campaign/term/content` + the common click-ids (e.g. `gclid`, `fbclid`, and the rest of posthog-js `CAMPAIGN_PARAMS`, `event-utils.ts:45-54`) from the current URL's query string into neutral keys, fresh per event when present — de-brand posthog-js `getCampaignParams` (`:87-113`). No `$`-prefix.
- **Session-entry props:** capture the entry url + referrer **once per session** and re-prefix them onto every event as neutral `session_entry_*` keys — de-brand posthog-js `session-props.ts` `getSessionProps` (`:106-117`). Store the entry `{url, referrer}` keyed to the current session id; reset on session rotation (only entry url + referrer are stored per session, NOT device/browser — matches posthog-js `session-props.ts:5-9`, `:29-32`). These persist in the existing property store. **Rotation is detected by REUSING E6-S1's adapter-side `lastSeenSessionId` comparison (id changed on an event ⇒ rotated) — NOT an `onSessionId` observer (the `SessionIdManager` has none; see S1).** On rotation, re-capture fresh entry props for the new session on that same first event; the first `undefined → id` transition establishes entry props for the initial session (adoption, not rotation).
- **Initial / set-once person props:** on first touch, set neutral `initial_*` attribution props (`initial_referrer`, `initial_referring_domain`, `initial_utm_*`, `initial_current_url`, …) set-once — de-brand posthog-js `getInitialPersonPropsFromInfo` (`:256-266`). Route through the existing `registerOnce`/set-once persistence so they are written once and never overwritten.

### Out

- The structured `enrichment` opt-out config (the `utm` toggle) — E6-S5.
- Country/GeoIP — E6-S6.
- The base per-event context (page/device/browser) — E6-S3 (this depends on it).

## Acceptance criteria

- [ ] When the URL carries `utm_*`/click-id params, an event captured through the adapter carries the neutral `utm_*`/click-id keys; absent params emit no keys. None `$`-prefixed.
- [ ] Session-entry url + referrer are captured once at session start and re-emitted as `session_entry_*` on every event in that session; a session rotation re-captures fresh entry props.
- [ ] `initial_*` attribution props are written set-once (first touch) and are NOT overwritten by a later capture with different params.
- [ ] These are library-computed ⇒ trusted (not allowlist-gated); the injected values derive from the URL/referrer, not consumer-supplied event props. (bar A + E3)
- [ ] All four gates green.

## Technical notes

- **Three distinct persistence lifespans** — get them right: per-event (utm parse, fresh each event when present), per-session (`session_entry_*`, tied to session id, reset on rotation), and set-once-per-identity (`initial_*`, first touch only). Do not collapse them. — posthog-source-guide (2026-07-08).
- `CAMPAIGN_PARAMS` + `getCampaignParams` (`event-utils.ts:45-54`, `:87-113`); `getSessionProps` (`session-props.ts:106-117`); `getInitialPersonPropsFromInfo` (`event-utils.ts:256-266`). All `$`-prefixed → de-brand to neutral keys. — posthog-source-guide (2026-07-08).
- Session-entry props store ONLY entry url + referrer per session (posthog-js deliberately does NOT store device/browser at session entry — header comment `session-props.ts:5-9`; stored shape `CurrentSessionSourceProps = { r, u }` at `:29-32`; `getSessionProps` re-prefixes as `$session_entry_*` at `:114`). — posthog-source-guide (2026-07-08).
- `initial_*` uses the existing set-once persistence (`store.registerOnce`, already used by super-props `register(..., {once:true})`) — reuse it, don't build a second set-once path.
- **Rotation reset — reuse S1's `lastSeenSessionId`, do NOT add an observer.** The `SessionIdManager` mints/expires the id but exposes NO `onSessionId` hook (`session-id-manager.ts:51-70` returns only the string). E6-S1 introduces an adapter-side `lastSeenSessionId` comparison in the capture pipeline to detect rotation; S4 reuses that SAME field and comparison to reset its per-session entry props — one rotation-detection mechanism serves both records. — architect (2026-07-08): §E6 Q1.
- **Cross-story coordination (orchestrator): sequence E6-S1 before E6-S4.** The epic dep graph lists S4 `depends_on: [E6-S3]` only, but this refinement makes S4 reuse S1's adapter-side `lastSeenSessionId` rotation-detection substrate. S1 and S4 both sit upstream of the S5 fan-in, so S1 lands first under the natural topo order — but pin it: **build S1 before S4.** If S4 is somehow built first, introduce the `lastSeenSessionId` field here (same shape S1 specifies) rather than inventing a second rotation-detection path — the two stories MUST share one field, not diverge. — story-refiner coordination note (2026-07-08).
- Library-computed ⇒ trusted; only consumer-supplied values are allowlist-gated. — architect (2026-07-07): epic §E6.4.

## Shipped
