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

The seam left `SessionReplayPort` as a one-method sketch (`ts/packages/analytics-kit/src/ports.ts:6`) and `replay?` as a declared-only slot on `AnalyticsProvider`. This story widens the port to its v1 control surface and adds the `sessionReplay?` config block with boundary validation — the pure neutral seam that defines **both acceptance bars** for the epic (bar A: one port every replay adapter satisfies; bar B: enable/sample/mask are all config). No rrweb, no browser code. Every downstream story (recorder, linkage, delivery) binds to what this story freezes.

## Scope

### In

- **Widen `SessionReplayPort`** in `ts/packages/analytics-kit/src/ports.ts` from `{ start }` to the v1 four-verb control surface:
  - `start(): void` — idempotent (a second call while active is a no-op).
  - `stop(): void` — halt recording (load-bearing: a consumer stops for a sensitive flow).
  - `isActive(): boolean` — the gate consumers branch on.
  - `getReplayId(): string | undefined` — the **neutral** session-linkage id, or `undefined` when inactive. NOT a vendor console URL.
  - Replace the "still a sketch / always undefined this release" comment with a neutral doc comment matching the `FeatureFlagPort` comment style (state by role, zero rrweb/vendor vocabulary).
- **Add `AnalyticsConfig.sessionReplay?`** in `ts/packages/analytics-kit/src/create-analytics.ts` — a `SessionReplayConfig` interface, sibling of `FlagsConfig`, with:
  - `enabled: boolean` — opt-in to recording (default OFF: absent/false records nothing).
  - `sampleRate?: number` — 0–1, boundary-validated (mirror the reference `isValidSampleRate`).
  - `masking?: { maskAllInputs?: boolean; maskTextSelector?: string; blockSelector?: string }` — the NEW privacy surface (default `maskAllInputs: true`). Field names are neutral CSS/DOM concepts, no rrweb type names.
- **Boundary validation** for the config block, mirroring the E12 config-validation precedent (the `sampleRate` 0–1 check + masking shape). If the repo validates config with Zod at the boundary, add the `sessionReplay` schema there; if E12 validated `FlagsConfig` with a plain guard, mirror that exact mechanism — **read how `FlagsConfig` is validated and match it** rather than introducing a new validation style.
- **Pin the port member surface** the way `FeatureFlagPort` is pinned in `ports.test.ts` — a `keyof SessionReplayPort` type-test frozen to `'start' | 'stop' | 'isActive' | 'getReplayId'`, so a 5th member is a deliberate break.

### Out

- **rrweb, the recorder, any browser code** — S2. This story is `ts/packages/analytics-kit/src/**` only (the neutral seam).
- **Populating `provider.replay`** — S2 wires the browser adapter's port impl into the slot. This story only widens the interface.
- **Snapshot delivery / buffering / masking ENFORCEMENT** — S4. This story defines the masking CONFIG shape; the recorder that honors it is S4.
- **Session/event linkage** — S3.
- **Canvas/network/min-max-duration config fields, `pause()`/`resume()`, a separate replay-endpoint host** — epic Out of scope (deferred, declared-not-omitted).

## Acceptance criteria

- [ ] `SessionReplayPort` is `{ start(): void; stop(): void; isActive(): boolean; getReplayId(): string | undefined }` with a neutral doc comment carrying zero rrweb/vendor vocabulary. `getReplayId` is typed and documented as the neutral session-linkage id, never a URL.
- [ ] `AnalyticsConfig.sessionReplay?: SessionReplayConfig` exists with `enabled`, optional `sampleRate` (0–1), and optional `masking` (`maskAllInputs`/`maskTextSelector`/`blockSelector`); the default masking posture is `maskAllInputs: true`.
- [ ] `sampleRate` outside `[0, 1]` (and a malformed `masking` shape) is rejected at the config boundary, mirroring how `FlagsConfig` is validated — no new validation mechanism introduced.
- [ ] A `keyof SessionReplayPort` type-test in `ports.test.ts` is frozen to the four members (a 5th member fails the test).
- [ ] The frozen-15 `keyof AnalyticsProvider` pin is UNDISTURBED — `replay` is already a member; this story does not add/remove provider members.
- [ ] Gates green: `cd ts && pnpm turbo run build test typecheck lint` + `pnpm neutrality-scan`. No vendor token on the port, the config keys, or the id.

## Technical notes

- **v1 port = `{ start, stop, isActive, getReplayId }`** — architect-locked (epic Notes → "Neutral port surface", 2026-07-10). Each verb has a direct `posthog-js` public-API analog (`startSessionRecording`/`stopSessionRecording`/`sessionRecordingStarted`/`get_session_id`, `posthog-core.ts:3152–3438`) but the port names none of them. `start` idempotent (mirrors the reference `isStarted` guard).
- **`getReplayId` = the neutral session-linkage id, NOT `getReplayUrl()`** — architect-locked (epic Notes → "Neutral port surface"). PostHog exposes both `get_session_id()` and `get_session_replay_url()` (a `/project/{token}/replay/{id}` console route). The URL bakes in a vendor console route → it does NOT go on the neutral port. Expose the id; a consumer builds a URL from it if their backend has one.
- **Config shape mirrors `FlagsConfig`** (`create-analytics.ts:16`) — a sibling interface added to the same file, referenced from `AnalyticsConfig` exactly as `flags?: FlagsConfig` is (`create-analytics.ts:87`). Read that block for the neutral-naming + doc-comment convention before writing.
- **`sampleRate` 0–1 validation mirrors the reference `isValidSampleRate`** — architect-locked (epic Notes → "Config vs port; privacy masking"). Match the E12 boundary-validation mechanism (read how `FlagsConfig` is validated — plain guard vs Zod — and use the SAME one).
- **Masking is a NEW, orthogonal privacy surface** — architect-locked (epic Notes → "Config vs port; privacy masking"). The E3/E4 allowlist gates *event property keys* (a `Set<string>` over `NeutralProperties`); masking gates *DOM content* (`maskAllInputs`, mask-text-selector, block-selector). Two channels, two policies, both consumer-owned. Do NOT derive one from the other, and do NOT thread masking through the allowlist. Default `maskAllInputs: true` (privacy-forward — the library has no remote-config UI to tune permissive defaults).
- **Frozen-15 provider pin undisturbed** — `replay?` is already an optional member of `AnalyticsProvider` (`analytics-provider.ts:56`) and the `keyof` pin already includes it. This story widens the PORT interface, not the provider; no frozen-15 disturbance. — epic Why.
- **Bar-A/bar-B-defining story** — everything a replay adapter must satisfy (bar A) and everything a consumer configures (bar B) is fixed here. If a downstream story finds it needs a 5th port method or a new config field, that's a gap to route back HERE, not to widen silently.
- No architect consult needed — every decision above is pre-resolved in the epic `## Notes`.

## Shipped
