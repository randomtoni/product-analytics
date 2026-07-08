---
id: E5-S7-bot-crawler-filtering
epic: E5-CAP-transport
status: ready-for-dev
area: capture
touches: [browser, adapters]
depends_on: []
api_impact: additive
---

# E5-S7-bot-crawler-filtering — Suppress bot/crawler traffic at capture time

## Why

Bot and crawler traffic pollutes every downstream metric. Filtering at capture time (before the event is enqueued) keeps the queue and the backend clean, and lets the consumer extend the denylist for their own known bots or opt out entirely.

## Scope

### In

- Port `posthog-js/packages/core/src/utils/bot-detection.ts` (de-branded): the `DEFAULT_BLOCKED_UA_STRS` substring denylist (~90 substrings) + the lowercase substring match, plus the browser `isLikelyBot` check (`navigator.webdriver` / userAgentData).
- Apply suppression at **capture time** in `BrowserAdapter.capture()` — a blocked UA short-circuits before the event is enqueued (before S2's queue).
- Consumer-extendable: a neutral config option to add UA substrings to the denylist, threaded through `resolveAdapter` → `BrowserAdapterOptions`.
- Config opt-out: a neutral switch to disable UA filtering entirely (de-brand PostHog's `opt_out_useragent_filter`).
- **Extend the `AnalyticsConfig` shape-pin literal** (`create-analytics.test.ts:167-182`) with both new fields (the opt-out switch + the denylist-extension array) in the same change, and thread them into the explicit `resolveAdapter` construction — see the S1 shape-pin note.

### Out

- Server-side bot filtering — E7-NODE-server-capture (server has no `navigator`; different signal).
- Any consumer callback / custom bot predicate beyond a UA-substring extension — keep the port minimal (BRIEF: only what we need).

## Acceptance criteria

- [ ] A blocked user-agent short-circuits `capture()` before the event is enqueued; a test with a denylisted UA asserts no event reaches the S2 queue.
- [ ] `navigator.webdriver` (and userAgentData where available) flags an automated client as a bot.
- [ ] A consumer-supplied denylist extension adds substrings to the default list; verified by a test capturing under a consumer-added UA substring.
- [ ] A config opt-out disables filtering entirely — an otherwise-blocked UA captures normally; a test asserts this (bar B: behavior is config-driven, zero library change).
- [ ] No vendor name appears in the ported denylist/constants — grep-clean; the denylist is neutral UA substrings.

## Technical notes

- **Port the UA denylist + webdriver check.** Port `posthog-js/packages/core/src/utils/bot-detection.ts` — `DEFAULT_BLOCKED_UA_STRS` (~90 substrings) + `isBlockedUA` lowercase substring match (`:3-114`), and browser's `isLikelyBot` (navigator.webdriver / userAgentData, `posthog-js/packages/browser/src/utils/blocked-uas.ts:24-57` — note the `utils/` path); suppression at capture time (`posthog-core.ts:1314-1321`). Consumer can extend the list; `opt_out_useragent_filter` disables. — architect (2026-07-07): §E5.8.
- **Gate BEFORE enqueue, in `capture()` — upstream of the S2 queue.** The suppression short-circuits `BrowserAdapter.capture()` (`browser-adapter.ts:115-119`) at the very top, before `runCapturePipeline` and before any S2 enqueue — a blocked UA never enters the pipeline or the queue. When S7 lands before S2 (`capture()` still drops post-pipeline), the gate is still correct: it just short-circuits earlier than the drop. `navigator` is DOM-typed under `lib: ["ES2022","DOM"]`, but read it defensively (`typeof navigator === 'undefined'` guard, mirroring `consent.ts:10`) so the adapter stays safe in a non-DOM test/SSR context.
- Neutralize the opt-out name: PostHog's `opt_out_useragent_filter` → a neutral config switch (e.g. `botFilter?: boolean`, default on) plus a denylist-extension array. No vendor option name on the neutral surface.
- No hard code dependency on other E5 stories — the filter gates `capture()` upstream of the queue. It can land in parallel with S2. (Listed independently so the topo-sort does not force it behind the transport core.)
- Reference: `posthog-js/packages/core/src/utils/bot-detection.ts` + the browser `posthog-js/packages/browser/src/utils/blocked-uas.ts`.

## Shipped
