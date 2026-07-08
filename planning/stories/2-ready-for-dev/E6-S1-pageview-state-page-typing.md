---
id: E6-S1-pageview-state-page-typing
epic: E6-CAP-capture-enrichment
status: ready-for-dev
area: capture
touches: [browser]
depends_on: []
api_impact: additive
---

# E6-S1-pageview-state-page-typing — Pageview state + typed `page()` substrate

## Why

`track`/`page` verbs already exist on the facade (E2); the missing piece is the browser-adapter **pageview-state** that a correct `pageleave` duration depends on (E6-S2 consumes it) and the typed `page`-props threading. This slice lands that substrate without adding any facade verb.

## Scope

### In

- In `BrowserAdapter`, hold an in-memory **current-pageview record** `{ timestamp, pageViewId, pathname }` (adapter-internal), set when a `page` event flows through `capture()`. Mint `pageViewId` with the adapter's UUIDv7 generator. This mirrors posthog-js `page-view.ts` `PageViewManager._currentPageview` (`:33`), de-branded — no `$`-prefixed keys.
- On session rotation, clear the current-pageview record so a new session starts a fresh pageview lineage. **The shipped `SessionIdManager` has NO `onSessionId` observer** (it only returns the id string from `checkAndGetSessionId`, `session-id-manager.ts:51-70`) — so detect rotation ADAPTER-SIDE: keep a `lastSeenSessionId` (init `undefined`) on the adapter and, in the capture pipeline where the id is already stamped, compare the id returned by `checkAndGetSessionId` against it; a *changed* id is a rotation → reset the record. Treat the first `undefined → id` transition as adoption (NOT rotation — no reset). See Technical notes; this diverges deliberately from posthog-js's `page-view.ts:46-70` (`onSessionId`) pub/sub. **This `lastSeenSessionId` field is shared substrate: E6-S4 reuses the SAME comparison to reset its per-session entry props — introduce it here.**
- Recognize a `page` event inside `capture()`/the pipeline via the neutral `RESERVED_PAGE_EVENT` constant (`'page'`, `analytics-kit/src/taxonomy.ts:3`) — the pageview record is set only for `page` events, not every `track`. **Note: `RESERVED_PAGE_EVENT` is NOT currently exported from the seam barrel (`analytics-kit/src/index.ts`)** — the browser adapter imports from `'analytics-kit'` (the barrel), so either export the constant from the seam `index.ts` (preferred — the facade already imports it internally) or compare against the `'page'` literal in the adapter. Pick the export path so there is one source of truth for the reserved name.
- Thread the taxonomy `page` prop typing already present in `ShapeOf` (`page: T extends { page: PropDecl } ? ...`) through to the facade `page(name?, props?)` signature so a consumer's declared `page` props type-check. Today `page(name?, props?: NeutralProperties)` is untyped against the taxonomy — tighten it to the taxonomy `page` shape without changing the runtime behavior.

### Out

- The `pageleave` event itself and duration computation — E6-S2 (consumes this record).
- Any context/UTM/device enrichment — E6-S3/S4.
- Auto-pageview-on-history-change (`capture_pageview: 'history_change'`): R1 pageviews stay **manual/router-driven** (`analytics.page(...)`), matching the BRIEF's framework-router-safe stance and the E9 provider note. Do NOT wire a history listener.
- Scroll-depth props (`$prev_pageview_*_scroll`): out this release — E6-S2 carries duration only.

## Acceptance criteria

- [ ] A `page` event captured through the browser adapter sets the current-pageview record (timestamp = event time, a fresh pageViewId, pathname); a subsequent non-`page` `track` does not overwrite it.
- [ ] Session rotation (idle/max-length expiry) clears the current-pageview record; the next `page` starts a fresh lineage. Rotation is detected by the adapter-side `lastSeenSessionId` comparison (id changed on an event ⇒ rotated); the very first `undefined → id` transition does NOT count as a rotation.
- [ ] The facade `page(name?, props?)` signature type-checks a consumer's taxonomy-declared `page` props (compile-time), and defaults to `NeutralProperties` when the taxonomy declares no `page` shape. Runtime behavior of `page()` is unchanged.
- [ ] No `$`-prefixed name and no new facade verb appear on the neutral surface — `keyof AnalyticsProvider` stays the frozen fifteen members (`analytics-provider.test.ts:587`). (bar A)
- [ ] All four gates green.

## Technical notes

- **No new facade verb — pin stays 15.** `track`/`page` already exist (E2). This story adds adapter-internal pageview STATE + tightens the `page()` type. Do NOT touch the frozen `keyof AnalyticsProvider` pin (`analytics-provider.test.ts:587`) — if you find yourself needing to, stop and re-check: pageview state is adapter-internal. — architect (2026-07-08): §E6 Q1.
- **Pageview record shape** de-brands posthog-js `page-view.ts` `PageViewManager._currentPageview` (`{ timestamp, pageViewId, pathname }`, `:33`). Keys stay neutral/internal — never `$pageview_id`. — posthog-source-guide (2026-07-08).
- **Session-rotation detection — pinned to adapter-side id-comparison, NOT an `onSessionId` observer.** Detect rotation by comparing the id returned from `checkAndGetSessionId` against a `lastSeenSessionId` (init `undefined`) in the capture pipeline — reset on *change*, treating the first `undefined→id` transition as adoption, not rotation. Do NOT add an `onSessionId` observer to `SessionIdManager`: it keeps the shared session class pure (it is currently timestamp-in/id-string-out with no listener state) and avoids coupling S1/S4 through a new pub/sub surface — both stories own one adapter-internal field + one comparison branch instead. No correctness gap vs the posthog observer: the reset runs on the same synchronous pass over the first event of the new session (same id-mint instant), and S9's `resetSessionId()` flows through the same comparison for free. — architect (2026-07-08): §E6 Q1 (diverges from posthog `sessionid.ts:125-139` / `page-view.ts:46-70`).
- The record is minted at `page()` time (not lazily at unload) so E6-S2 can compute `now − record.timestamp` at unload for a correct duration. — architect (2026-07-08): §E6 Q1.
- `page` is already a reserved neutral event name (`RESERVED_PAGE_EVENT = 'page'`, `taxonomy.ts:3`; the taxonomy type bars a consumer from redeclaring it as a custom event). Reuse it — do not invent a second pageview constant.
- Pageviews are **manual/router-driven** in R1 (no history-change auto-capture); this is locked and matches the E9 React-provider stance. — architect (2026-07-07): §E9 ("pageview capture is manual/router-driven").

## Shipped
