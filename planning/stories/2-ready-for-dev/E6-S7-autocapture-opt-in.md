---
id: E6-S7-autocapture-opt-in
epic: E6-CAP-capture-enrichment
status: ready-for-dev
area: capture
touches: [browser]
depends_on: [E6-S3-context-enrichment-port]
api_impact: additive
---

# E6-S7-autocapture-opt-in — DOM autocapture (opt-in, default OFF)

# THIS IS THE LARGE / HIGH-RISK STORY OF THE EPIC — its own story by design.

## Why

DOM autocapture (clicks/changes/form-submits → element metadata) is the largest, riskiest port in E6. It ships opt-in, default OFF, with PostHog's remote-config phone-home REMOVED — a de-branded autocapture must never call home for gating.

## Scope

### In

- Port posthog-js `autocapture.ts` + `autocapture-utils.ts`, de-branded, minimal:
  - Capture-phase `document` listeners for `submit` / `change` / `click` (`autocapture.ts:305-307`), with the same event/element gating (`shouldCaptureDomEvent`, `autocapture-utils.ts:366-438`).
  - Element metadata extraction → neutral keys (de-brand `$elements_chain` → e.g. `elements_chain`, `$el_text` → `el_text`, `$event_type` → `event_type`; the `attr__<name>` allowlist scheme; `tag_name`/`classes`/`nth_child`/`nth_of_type`) — posthog-js `autocapturePropertiesForElement` (`:145-258`).
  - A configurable skip-class (de-brand `ph-no-capture` / `ph-no-autocapture` / `[data-ph-no-autocapture]`) — the class/attr NAMES must be configurable/neutral, not baked with a vendor prefix. Also the sensitive-value scrub (CC/SSN, password/hidden inputs) from `shouldCaptureValue` / `isSensitiveElement`.
- **Default OFF, opt-in via a plain browser-adapter config boolean** `autocapture` (default `false`). Add it to `AnalyticsConfig` + thread through `resolveAdapter` + update the `AnalyticsConfig` shape-pin (`create-analytics.test.ts:167`).
- Autocaptured events flow through the SAME `capture()` pipeline (bot gate → rate limiter → enrichment → wire map → transport) — an autocaptured click is a normal neutral event.

### Out

- **The remote-config gate — REMOVED, not ported.** posthog-js's `isEnabled` "wait for the server, enable unless `autocapture_opt_out`" model (`autocapture.ts:331-351`, `:372-384`) is the phone-home. Do NOT port it. Autocapture is on/off purely from local config — no network call for gating. This is a required [WIRE] divergence, not optional.
- Rageclick, dead-click, copy-autocapture (`capture_copied_text`), heatmap/scroll — skip this release; the minimal port extends additively later (epic Out of scope).
- **Per-context** autocapture (different setting per named context) — E6-S8. This story ships a SINGLE plain `autocapture` boolean (one implicit context); S8 lets a named profile override it. Per the architect, autocapture on/off does NOT need the profile machinery — it degrades cleanly to one config flag. — architect (2026-07-08): §E6 Q2.

## Acceptance criteria

- [ ] With `autocapture: true`, a click/change/submit on a compatible element produces a neutral autocapture event with de-branded element metadata (elements chain, el_text, event_type, attr__ allowlist) flowing through the normal capture pipeline.
- [ ] Default (`autocapture` unset or `false`) = NO DOM listeners bound, zero autocapture events. (opt-in, default off — bar B)
- [ ] **No network call is made for autocapture gating** — the remote-config phone-home is absent (verifiable: init + autocapture make no gating request). This is the load-bearing divergence.
- [ ] The skip-class and sensitive-value scrub work; element attribute capture honors the allowlist + sensitivity restrictions; skip-class/attr names carry NO vendor prefix on the neutral surface.
- [ ] `autocapture` is threaded through `resolveAdapter` and the `AnalyticsConfig` shape-pin includes it and passes; `keyof AnalyticsProvider` pin stays fifteen. (bar B)
- [ ] Autocapture listeners are torn down on `shutdown()` (mirror the existing unload-listener teardown).
- [ ] All four gates green.

## Technical notes

- **This is the epic's biggest de-branding job** — posthog-js autocapture is deeply entangled with PostHog config, remote config, and `$`-vocabulary. Port MINIMALLY (submit/change/click + elements chain + sensitive scrub) and strip everything remote-config. Budget accordingly; it may warrant splitting during implementation, but the opt-in + phone-home-removal are non-negotiable. — architect (2026-07-07): epic §E6.6.
- **The phone-home to strip (exact location):** `isEnabled` getter (`autocapture.ts:372-384`) returns `false` until the server responds when `isNull(memoryDisabled)`; `onRemoteConfig` (`:331-351`) reads `response['autocapture_opt_out']`. Remove both — replace with the local `autocapture` boolean. posthog-js default is ON (`posthog-core.ts:233`); we default OFF per BRIEF. — posthog-source-guide (2026-07-08).
- Element extraction surface (de-brand all): `$elements_chain`, `$el_text`, `$event_type`, `$ce_version`, `attr__*`, `data-ph-capture-attribute-*`, skip classes `ph-no-capture`/`ph-sensitive`/`ph-no-autocapture` — all PostHog DOM vocabulary; the NAMES must not leak (make skip-class/attr-prefix configurable/neutral). — posthog-source-guide (2026-07-08).
- Sensitive-value scrub (`shouldCaptureValue` CC/SSN, `isSensitiveElement` password/hidden) is UNIVERSAL — keep it (a privacy floor), just neutralize names. — posthog-source-guide (2026-07-08).
- Autocaptured events ride the normal `capture()` pipeline — they inherit bot gate, rate limiter, enrichment, allowlist posture for free. Element metadata is library-computed ⇒ trusted (not consumer-supplied event props). — architect (2026-07-08).
- Listener teardown on `shutdown()` mirrors `detachUnloadListeners` (`browser-adapter.ts:232`, `:502`).

## Shipped
