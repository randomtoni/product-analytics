---
id: E14-S1-neutral-replay-port-config-substrate
epic: E14-SR-session-replay
status: ready-for-dev
area: session-replay
touches: [core]
depends_on: []
api_impact: additive
---

# E14-S1-neutral-replay-port-config-substrate — Neutral replay port + config substrate (seam)

## Why

The seam left `SessionReplayPort` as a one-method sketch (`ts/packages/analytics-kit/src/ports.ts:6-8`, `start(): void` at `:7`) and `replay?` as a declared-only slot on `AnalyticsProvider`. This story widens the port to its v1 control surface and adds the `sessionReplay?` config block as a plain **type carrier** — the pure neutral seam that defines **both acceptance bars** for the epic (bar A: one port every replay adapter satisfies; bar B: enable/sample/mask are all config). No rrweb, no browser code, and **no runtime validation** (the seam does zero config validation today — see Technical notes; `sampleRate` normalization is a browser-recorder concern deferred to S4, alongside the sampling machinery). Every downstream story (recorder, linkage, delivery) binds to what this story freezes.

## Scope

### In

- **Widen `SessionReplayPort`** in `ts/packages/analytics-kit/src/ports.ts` from `{ start }` to the v1 four-verb control surface:
  - `start(): void` — idempotent (a second call while active is a no-op).
  - `stop(): void` — halt recording (load-bearing: a consumer stops for a sensitive flow).
  - `isActive(): boolean` — the gate consumers branch on.
  - `getReplayId(): string | undefined` — the **neutral** session-linkage id, or `undefined` when inactive. NOT a vendor console URL.
  - Replace the "still a sketch / always undefined this release" comment with a neutral doc comment matching the `FeatureFlagPort` comment style (state by role, zero rrweb/vendor vocabulary).
- **Add `AnalyticsConfig.sessionReplay?`** in `ts/packages/analytics-kit/src/create-analytics.ts` — a `SessionReplayConfig` interface, sibling of `FlagsConfig` (`create-analytics.ts:16`), referenced from `AnalyticsConfig` exactly as `flags?: FlagsConfig` is (`:87`), with:
  - `enabled: boolean` — opt-in to recording (default OFF: absent/false records nothing).
  - `sampleRate?: number` — a plain optional number in [0,1]. **Type carrier only — do NOT add runtime validation in the seam** (the seam validates NOTHING today; normalization is a browser-recorder concern — see below and Technical notes).
  - `masking?: { maskAllInputs?: boolean; maskTextSelector?: string; blockSelector?: string }` — the NEW privacy surface (default `maskAllInputs: true`, applied by the recorder in S4). Field names are neutral CSS/DOM concepts, no rrweb type names.
- **No boundary validation in this story.** The seam `createAnalytics` does zero config validation (verified: `FlagsConfig` is passed straight through with no guard; there is no Zod anywhere in the repo). Do NOT introduce a validation mechanism the codebase lacks. `sessionReplay` is a plain optional-config type carrier here. **`sampleRate` normalization** (finite-and-in-[0,1] → use; anything else → fall back to unset/default sampling behavior, with a dev warning; never throw, never fail init) belongs in the **browser replay recorder** where it is constructed — mirroring the browser target's shipped numeric-config normalization precedent (`request-queue.ts:23-39` `clampInterval`/`clampFlushAt`, `browser-adapter.ts:167`) — and lands with the sampling machinery in **S4** (the recorder in S2 wires it, the sampling decision in S4 enforces it). — architect (2026-07-10, refine).
- **Pin the port member surface** the way `FeatureFlagPort` is pinned in `ports.test.ts:38-39` — `expectTypeOf<keyof SessionReplayPort>().toEqualTypeOf<'start' | 'stop' | 'isActive' | 'getReplayId'>()`, so a 5th member is a deliberate break. Mirror the exact `expectTypeOf` mechanism (not a hand-rolled `Equals`; that pattern is the fernly `capability-presence.ts` layer, pinned separately in S5).

### Out

- **rrweb, the recorder, any browser code** — S2. This story is `ts/packages/analytics-kit/src/**` only (the neutral seam).
- **Populating `provider.replay`** — S2 wires the browser adapter's port impl into the slot. This story only widens the interface.
- **Snapshot delivery / buffering / masking ENFORCEMENT** — S4. This story defines the masking CONFIG shape; the recorder that honors it is S4.
- **`sampleRate` runtime normalization/validation** — S4 (browser recorder). This story only declares the `sampleRate?: number` type; the finite/in-range normalization (clamp-family, normalize-to-default-not-throw) lives in the browser replay module next to the `request-queue.ts` `clamp*` precedent. — architect (2026-07-10).
- **Session/event linkage** — S3.
- **Canvas/network/min-max-duration config fields, `pause()`/`resume()`, a separate replay-endpoint host** — epic Out of scope (deferred, declared-not-omitted).

## Acceptance criteria

- [ ] `SessionReplayPort` is `{ start(): void; stop(): void; isActive(): boolean; getReplayId(): string | undefined }` with a neutral doc comment carrying zero rrweb/vendor vocabulary. `getReplayId` is typed and documented as the neutral session-linkage id, never a URL.
- [ ] `AnalyticsConfig.sessionReplay?: SessionReplayConfig` exists with `enabled`, optional `sampleRate` (typed `number`, documented as [0,1]), and optional `masking` (`maskAllInputs`/`maskTextSelector`/`blockSelector`); the default masking posture (`maskAllInputs: true`) is documented as the recorder's default (enforced in S4), not applied here.
- [ ] `sessionReplay` is a plain optional-config type carrier — **no runtime validation is added to the seam** (matching the seam's existing zero-config-validation shape; `FlagsConfig` is likewise unvalidated, and there is no Zod in the repo). `sampleRate` normalization is explicitly deferred to the browser recorder (S4). No new validation mechanism is introduced anywhere in this story.
- [ ] A `keyof SessionReplayPort` type-test in `ports.test.ts` is frozen to the four members (a 5th member fails the test).
- [ ] The frozen-15 `keyof AnalyticsProvider` pin is UNDISTURBED — `replay` is already a member; this story does not add/remove provider members.
- [ ] Gates green: `cd ts && pnpm turbo run build test typecheck lint` + `pnpm neutrality-scan`. No vendor token on the port, the config keys, or the id.

## Technical notes

- **v1 port = `{ start, stop, isActive, getReplayId }`** — architect-locked (epic Notes → "Neutral port surface", 2026-07-10). Each verb has a direct `posthog-js` public-API analog (`startSessionRecording`/`stopSessionRecording`/`sessionRecordingStarted`/`get_session_id`, `posthog-core.ts:3152–3438`) but the port names none of them. `start` idempotent (mirrors the reference `isStarted` guard).
- **`getReplayId` = the neutral session-linkage id, NOT `getReplayUrl()`** — architect-locked (epic Notes → "Neutral port surface"). PostHog exposes both `get_session_id()` and `get_session_replay_url()` (a `/project/{token}/replay/{id}` console route). The URL bakes in a vendor console route → it does NOT go on the neutral port. Expose the id; a consumer builds a URL from it if their backend has one.
- **Config shape mirrors `FlagsConfig`** (`create-analytics.ts:16`) — a sibling interface added to the same file, referenced from `AnalyticsConfig` exactly as `flags?: FlagsConfig` is (`create-analytics.ts:87`). Read that block for the neutral-naming + doc-comment convention before writing.
- **CORRECTION vs the epic Notes' "Zod boundary" / "mirror `FlagsConfig` validation" framing** — architect-reviewed at refine (2026-07-10). That framing is false against the shipped code: (1) `FlagsConfig` has ZERO boundary validation — config is passed straight through `createAnalytics` into the provider, and `attachFlags` (`browser/src/create-analytics.ts:102`) just reads `config.flags?.bootstrap`; (2) there is NO Zod anywhere in the repo (not in any `package.json`, not imported in any `src` file) — the CLAUDE.md "Zod at boundaries" convention is aspirational, unrealized in the shipped seam. So there is nothing to mirror and no Zod boundary to add to. **This story adds no validation.** The seam type stays honest (`sampleRate?: number`) and the neutral surface makes NO promise that an out-of-range value is rejected — only that it is handled safely (by the recorder, S4).
- **`sampleRate` normalization = normalize-to-default in the browser recorder, NOT reject at the seam** — architect-locked (refine, 2026-07-10). The established precedent for out-of-range NUMERIC config is CLAMP/normalize, never throw: `request-queue.ts:23-39` (`clampInterval`/`clampFlushAt`; `flushInterval` clamped [250,5000], `browser-adapter.ts:167`). The reference `isValidSampleRate` (`@posthog/core`) returns a boolean and PostHog's `_validateSampleRate` (`session-recording.ts:166-176`) warns-and-ignores — it does NOT fail init. **Direction nuance:** for a sample rate the safe fallback is "treat as unset/default sampling," NOT `Math.min(Math.max(...))` to the nearest bound — clamping `1.1 → 1` silently records 100% of sessions (the expensive surprise). This normalization lands in **S4** (with the sampling decision); S1 only declares the type.
- **Masking is a NEW, orthogonal privacy surface** — architect-locked (epic Notes → "Config vs port; privacy masking"). The E3/E4 allowlist gates *event property keys* (a `Set<string>` over `NeutralProperties`); masking gates *DOM content* (`maskAllInputs`, mask-text-selector, block-selector). Two channels, two policies, both consumer-owned. Do NOT derive one from the other, and do NOT thread masking through the allowlist. Default `maskAllInputs: true` (privacy-forward — the library has no remote-config UI to tune permissive defaults).
- **Frozen-15 provider pin undisturbed** — `replay?` is already an optional member of `AnalyticsProvider` (`analytics-provider.ts:56`) and the `keyof` pin already includes it. This story widens the PORT interface, not the provider; no frozen-15 disturbance. — epic Why.
- **Bar-A/bar-B-defining story** — everything a replay adapter must satisfy (bar A) and everything a consumer configures (bar B) is fixed here. If a downstream story finds it needs a 5th port method or a new config field, that's a gap to route back HERE, not to widen silently.
- No architect consult needed — every decision above is pre-resolved in the epic `## Notes`.

## Shipped

> Captured by `implement-epics` on 2026-07-10.

- **Files changed:** `ts/packages/analytics-kit/src/{ports.ts,create-analytics.ts,index.ts}` + tests (`ports.test.ts`, `create-analytics.test.ts`)
- **New public API:** `SessionReplayPort` widened to `{ start(): void; stop(): void; isActive(): boolean; getReplayId(): string | undefined }` (`getReplayId` = NEUTRAL session-linkage id, NEVER the vendor console URL); `SessionReplayConfig` (`{ enabled?, sampleRate?, masking? }`) + `AnalyticsConfig.sessionReplay?` — a PLAIN type carrier, exported from the seam index. No adapter wired.
- **Tests added:** `ports.test.ts` (the `keyof SessionReplayPort` exact-4-member pin + per-verb signature pins), `create-analytics.test.ts` (config passes through un-validated — `sampleRate: 1.7`/`-3` do NOT throw, the guard against seam validation creeping in).
- **Commit:** `main` (message = story title)
- **Reviewer notes:** ship-ready, no critical, first review. Reviewer confirmed the key catch — posthog exposes BOTH `get_session_id()` AND `get_session_replay_url()` (a console route); the neutral port takes ONLY the id (plain `string | undefined`, doc forbids the URL). Config is a plain type carrier (no Zod in the repo; `FlagsConfig` precedent) with `sampleRate` normalization correctly DEFERRED to S4. Frozen-15 undisturbed (`replay?` already a member; port widened, not the provider set; slot-type pin still correct). Neutrality clean (no `posthog`/`rrweb`/`$snapshot`; masking field names are generic DOM selectors, de-brand-safe). One style nit (a `.not.toMatchTypeOf` mix — correct, keep). No adapter/Scope.Out leaked.
- **Cross-story seams exposed:** **S2** — attach the rrweb recorder to `provider.replay` (via a sibling `attachReplay`, the `attachFlags` precedent) + read `config.sessionReplay`; the port `getReplayId` returns the SHARED session id (S3 wires the linkage). **S4** — owns `sampleRate` normalization (normalize-to-default per the `request-queue.ts` clamp precedent, NOT reject) + the masking `maskAllInputs: true` default (S1 only carries the type). The port's 4-member surface is frozen — S2/S3/S4 satisfy it, don't widen it. **S5** — pins `FrozenReplayMembers = keyof SessionReplayPort` in fernly `capability-presence.ts`; Python `replay` stays N-A-by-platform.
