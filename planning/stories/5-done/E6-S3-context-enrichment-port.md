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
- **The UA parse is a pure, DOM-free function** `parseUserAgent(uaString, hints?)` (its own module), returning `{ browser, browser_version, os, os_version }` — de-branded from `@posthog/core` `utils/user-agent-utils.ts` (`packages/core/src/utils/user-agent-utils.ts`) (`detectBrowser`/`detectBrowserVersion`/`detectOS`, pure UA-string functions). Environment reads (`navigator`, `screen`, `window.inner*`) live in the enrichment module and are passed IN — the parser touches no DOM. `device_type` reads screen signals (not pure UA) per posthog-js `detectDeviceType` (`:315-322`) — keep it in the enrichment module, not the pure parser.
- Slot the enrichment into `runCapturePipeline` (`browser-adapter.ts:358-360`) as a NEW outermost wrap: today it is `mergeSuperProperties(stampSessionId(event))`; add the enrichment so it becomes `enrichContext(mergeSuperProperties(stampSessionId(event)))` — i.e. **after** `mergeSuperProperties`. **`toWireEvent` is NOT inside `runCapturePipeline`** — it is called separately in `capture()` (`:344`) on the pipeline's return, so "before `toWireEvent`" is satisfied automatically by staying inside `runCapturePipeline`. Enrichment keys are **library-computed ⇒ trusted** — added downstream of the E3 facade allowlist, no re-gate.
- **Precedence (load-bearing spread order):** a per-call consumer property of the same key WINS over a computed context key (context is a default, like super-props). Mirror `mergeSuperProperties`'s spread (`browser-adapter.ts:392`, `{ ...superProps, ...event.properties }`): merge context as `properties: { ...contextKeys, ...event.properties }` so the incoming (consumer + super-prop) bag overrides the computed defaults.
- Non-DOM safety: the enrichment module degrades gracefully in SSR/test — no throw when there is no DOM. Reuse the adapter's existing guard patterns: `typeof navigator === 'undefined'` (`browser-adapter.ts:353`), `typeof window/document === 'undefined'` (`:241-242`), and the `dom.ts` `hasDocument()` helper (`dom.ts:1-3`). Guard every environment read (`location`, `navigator`, `screen`, `window.inner*`) so a missing DOM yields absent context keys, not a throw.

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
- **Pure UA parser confirmed feasible:** `@posthog/core` `utils/user-agent-utils.ts` (`packages/core/src/utils/user-agent-utils.ts`) `detectBrowser`/`detectBrowserVersion`/`detectOS` are pure functions of the UA string (+ `navigator.vendor`/hints passed in). Keep the parser DOM-free; the enrichment module does the environment reads and passes them in. — posthog-source-guide (2026-07-08).
- **UA-adjacency to bot-detection (E5 carry-forward):** E5-S7's reviewer flagged that the DOM-free bot denylist (`DEFAULT_BLOCKED_UA_STRS`/`isBlockedUA` in `bot-detection.ts`) should hoist to the seam when E7 (node) needs it server-side — that is an **E7 concern, not E6**. E6's UA-context parser also reads the UA, so keep the two SEPARATE concerns: `parseUserAgent` (device/browser context) is a distinct module from `bot-detection.ts` (crawler gate). Do not merge them; do not touch `bot-detection.ts`. — reviewer/architect (E5-S7), carried to E6.
- Enrichment slots into `runCapturePipeline` as the new outermost wrap, AFTER `mergeSuperProperties` (`browser-adapter.ts:358-360`); `toWireEvent` runs after the pipeline returns (`:344`), so no change to that call. — epic §E-cross; architect (2026-07-07).
- **De-brand at the source — there is NO `$`-renaming step in the wire-mapper today.** The enrichment module writes NEUTRAL keys (`current_url`, `browser`, `device_type`, …) directly into `event.properties`; `mapEventToWire` (`wire-mapper.ts:40-53`) passes `properties` through verbatim (it only lifts the merge/traits bags — it does NOT re-prefix property keys). So "neutral names on the surface, `$`-names on the wire" is achieved by the enrichment writing neutral keys and there being no `$`-prefixing at all — do NOT introduce a `$current_url`→wire rename or expect the wire-mapper to add one. The `$`-prefixed posthog names are the REFERENCE we de-brand FROM, not a wire target we map TO. (The `disableGeoip`/`$geoip_disable` case in S6 is genuinely different — that is a config-driven adapter-internal flag, not a property-key rename.) — corrected against `wire-mapper.ts` (2026-07-08).
- Library-computed enrichment is trusted; only consumer-supplied values are allowlist-gated (the E4-S7 / E3.4 distinction). — architect (2026-07-07): epic §E6.4.

## Shipped
- > Reviewer suggestion (2026-07-08): `screen_*`/`viewport_*` are written unconditionally once `screen`/`win` exist (even if `0`) — faithful to posthog's unconditional build, but the other groups conditionally omit falsy values, so the module is slightly inconsistent. Add a `> 0` guard if "absent-when-zero" is wanted later.
- > Reviewer suggestion (2026-07-08, cosmetic): the brave hint uses `nav?.brave` (typed `unknown`) truthiness — `Boolean(nav?.brave)` / `!= null` would document intent better.

## Shipped

> Captured by `implement-epics` on 2026-07-08. (Builder's self-report was lost to a transient API 500 during report generation; the work landed complete and all gates were independently confirmed green, then reviewer-verified against every AC.)

- **Files added (browser):** `user-agent.ts` (PURE DOM-free `parseUserAgent(ua, hints?)` → `{browser, browser_version, os, os_version}` via `detectBrowser`/`detectBrowserVersion`/`detectOS`; de-branded from `@posthog/core` user-agent-utils) + test; `context-enrichment.ts` (`buildContext` — fresh-per-event neutral page/device/referrer/timezone/lib bag; does ALL env reads + passes signals into the pure parser; `device_type` from screen signals; `$direct`→internal `'direct'`) + test
- **Files changed:** `browser-adapter.ts` (`enrichContext` slotted as OUTERMOST wrap in `runCapturePipeline` = `enrichContext(mergeSuperProperties(stampSessionId(event)))`, after super-props; consumer/super-prop props win via `{...context, ...event.properties}`)
- **New public API:** none — enrichment adapter-internal; context keys neutral (no `$`), library-computed ⇒ trusted (NOT allowlist-gated). Seam UNCHANGED.
- **Tests added:** browser +34 (user-agent purity + Chrome/FF/Safari/mobile/Edge/Brave/unknown coverage; context fresh-per-event, non-DOM no-throw, consumer/super-prop override, not-gated-under-restrictive-allowlist end-to-end) → 467; seam 139
- **Commit:** `E6-S3-context-enrichment-port — Page + device/browser + referrer context enrichment` on `core-cycle`
- **Reviewer notes:** 0 critical, 3 suggestions (screen/viewport zero-guard consistency; brave Boolean cast; checkbox housekeeping)
- **Cross-story seams exposed:** **S4** adds the set-once/session-entry layer (`$initial_*`/`$session_entry_*` equivalents) + reads referrer/UTM — composes with this fresh-per-event layer, don't conflate. **S5** makes each enrichment (page/device/referrer) individually disable-able — `buildContext` is structured so S5 can toggle groups independently; also owns the `capturePageleave` rewire. **S6** adds `country` (consumer-supplied ⇒ gated, via facade `register`). `parseUserAgent` is DOM-free and hoistable to the seam if E7 (node) needs UA parsing — kept SEPARATE from `bot-detection.ts`.
