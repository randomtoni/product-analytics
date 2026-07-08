---
id: E6-S3-context-enrichment-port
epic: E6-CAP-capture-enrichment
status: ready-for-dev
area: capture
touches: [browser]
depends_on: []
api_impact: additive
---

# E6-S3-context-enrichment-port — Page + device/browser + referrer context enrichment

## Why

Auto-enriched context (page url/path/host, device/browser/OS, referrer, timezone, lib) is what makes captured events useful. This ports posthog-js's per-event property build, de-branded to neutral keys, and slots it into the capture pipeline downstream of super-props.

## Scope

### In

- A new browser-target enrichment module that computes, **fresh on every event**, the neutral equivalents of posthog-js `event-utils.ts` `getEventProperties` (`:293-354`):
  - Page context: `current_url`, `host`, `pathname` (from `location.*`).
  - Device/browser/OS: `browser`, `browser_version`, `os`, `os_version`, `device_type`, plus `screen_height/width`, `viewport_height/width`, `browser_language`.
  - Referrer: `referrer`, `referring_domain` (de-brand posthog-js `getReferrerInfo` `:194-210`; the `$direct` sentinel becomes a neutral `'direct'` default, kept internal).
  - `timezone`, `timezone_offset`; `lib`, `lib_version` (the adapter's own `getLibraryId()`/`getLibraryVersion()`).
- **The UA parse is a pure, DOM-free function** `parseUserAgent(uaString, hints?)` (its own module), returning `{ browser, browser_version, os, os_version }` — de-branded from `@posthog/core` `user-agent-utils.ts` (`detectBrowser`/`detectBrowserVersion`/`detectOS`, pure UA-string functions). Environment reads (`navigator`, `screen`, `window.inner*`) live in the enrichment module and are passed IN — the parser touches no DOM. `device_type` reads screen signals (not pure UA) per posthog-js `detectDeviceType` (`:315-322`) — keep it in the enrichment module, not the pure parser.
- Slot the enrichment into `runCapturePipeline`, **after** `mergeSuperProperties`, **before** `toWireEvent`. Enrichment keys are **library-computed ⇒ trusted** — added downstream of the E3 facade allowlist, no re-gate. A per-call consumer property of the same key WINS over a computed context key (context is a default, like super-props).
- Non-DOM safety: the enrichment module degrades gracefully in SSR/test (mirror the adapter's existing `typeof navigator === 'undefined'` guard) — no throw when there is no DOM.

### Out

- UTM/campaign params + session-entry/initial set-once props — E6-S4 (depends on this).
- The structured `enrichment` opt-out config — E6-S5. This story wires enrichment ON unconditionally; S5 makes each module individually disable-able. (Sequencing: land the port, then the opt-out surface.)
- Country/GeoIP — E6-S6.
- Bot detection — already shipped (E5-S7); do NOT touch `bot-detection.ts`. See the UA-adjacency note.

## Acceptance criteria

- [ ] An event captured through the browser adapter carries neutral page/device/browser/referrer/timezone/lib context keys — **none `$`-prefixed** — computed fresh per event. (bar A)
- [ ] `parseUserAgent(uaString)` is a pure function: same input → same output, no `navigator`/`window`/`document` reads inside it (verifiable by calling it with a string in a non-DOM test).
- [ ] A per-call consumer prop with the same key as a context key wins (context is a default).
- [ ] Context keys are NOT allowlist-gated (library-computed ⇒ trusted); only consumer-supplied props remain gated at the facade. (bar A + E3)
- [ ] In a non-DOM context, capture with enrichment does not throw.
- [ ] All four gates green.

## Technical notes

- **Fresh-per-event vs set-once split:** page/device/browser/referrer/timezone are computed fresh on EVERY event (posthog-js `getEventProperties` is per-capture, `:293-354`). The set-once/session-entry layer (`$initial_*`, `$session_entry_*`) is E6-S4 — do NOT conflate. — posthog-source-guide (2026-07-08).
- **Pure UA parser confirmed feasible:** `@posthog/core` `user-agent-utils.ts` `detectBrowser`/`detectBrowserVersion`/`detectOS` are pure functions of the UA string (+ `navigator.vendor`/hints passed in). Keep the parser DOM-free; the enrichment module does the environment reads and passes them in. — posthog-source-guide (2026-07-08).
- **UA-adjacency to bot-detection (E5 carry-forward):** E5-S7's reviewer flagged that the DOM-free bot denylist (`DEFAULT_BLOCKED_UA_STRS`/`isBlockedUA` in `bot-detection.ts`) should hoist to the seam when E7 (node) needs it server-side — that is an **E7 concern, not E6**. E6's UA-context parser also reads the UA, so keep the two SEPARATE concerns: `parseUserAgent` (device/browser context) is a distinct module from `bot-detection.ts` (crawler gate). Do not merge them; do not touch `bot-detection.ts`. — reviewer/architect (E5-S7), carried to E6.
- Enrichment slots into `runCapturePipeline` AFTER `mergeSuperProperties`, BEFORE `toWireEvent` (`browser-adapter.ts:358-360`). — epic §E-cross; architect (2026-07-07).
- All names de-brand: `$current_url`→`current_url`, `$browser`→`browser`, `$device_type`→`device_type`, etc. `$`-prefixed names are [WIRE], normalized by the adapter's wire-mapper — none on the neutral surface. — architect (2026-07-07): epic §E6 Notes.
- Library-computed enrichment is trusted; only consumer-supplied values are allowlist-gated (the E4-S7 / E3.4 distinction). — architect (2026-07-07): epic §E6.4.

## Shipped
