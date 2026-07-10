---
id: E14-S2-recorder-rrweb-behind-adapter
epic: E14-SR-session-replay
status: ready-for-dev
area: session-replay
touches: [browser]
depends_on: [E14-S1]
api_impact: additive
---

# E14-S2-recorder-rrweb-behind-adapter — Recorder + rrweb behind the adapter (separate entrypoint)

## Why

S1 froze the neutral port; this story makes it real in the browser target. It adds a replay module to `@analytics-kit/browser` that drives rrweb behind the adapter, wires `start`/`stop`/`isActive`, and populates `provider.replay`. The rrweb dependency and the recorder live entirely behind the adapter — the neutral surface stays rrweb-free. Critically, the replay module is a **separate tsup entrypoint** so a consumer who never enables replay does not bundle rrweb (~100KB+); getting this entry boundary right is load-bearing (changing it later is breaking).

## Scope

### In

- **A replay module in `@analytics-kit/browser`** (e.g. `src/replay/`) implementing `SessionReplayPort`:
  - `start()` — begins an rrweb recording (idempotent via an `isStarted` guard); `stop()` — halts it; `isActive()` — reports the guard; `getReplayId()` — returns the neutral session id (S3 wires the real linkage; this story may return the recorder's current session id as a placeholder that S3 replaces with the shared `SessionIdManager` read).
  - Import **upstream `rrweb` (`rrweb-io/rrweb`, MIT)** — add it to `ts/packages/browser/package.json` `dependencies`. **NEVER `@posthog/rrweb-*`.**
  - rrweb types (`record`, `eventWithTime`, snapshot/mutation types) live ONLY inside this module; nothing rrweb reaches the neutral port or the `@analytics-kit/browser` public index for the base entry.
- **Separate tsup entrypoint** — the replay module is its own subpath export of `@analytics-kit/browser` (e.g. `@analytics-kit/browser/replay`):
  - Add a second `entry` to `ts/packages/browser/tsup.config.ts` (the base config is single-entry `src/index.ts` — this story adds the replay entry).
  - Add the subpath to `package.json` `exports` (with `types`/`import`/`require` conditions, mirroring the `.` entry).
  - Importing the base `@analytics-kit/browser` must NOT pull rrweb into the graph — verify the base bundle stays rrweb-free.
- **Populate `provider.replay`** — the browser adapter/factory constructs the replay port impl when `config.sessionReplay?.enabled` is set, and exposes it as `provider.replay` (mirror how `provider.flags` is populated by the browser flag adapter). Absent/disabled → `replay` stays `undefined`.
- **Verify the neutrality-scan dep dimension** — after adding `rrweb`, run `pnpm neutrality-scan` and confirm `rrweb` in `dependencies` does not trip the name-check (`neutrality-scan.ts:226` reads `package.json` `name`, not the `dependencies` list).

### Out

- **Session/event linkage + re-key on rotation** — S3. This story may return a placeholder replay id; S3 wires the shared `SessionIdManager` read + rotation re-key.
- **Snapshot buffering, delivery, flush cadence, masking ENFORCEMENT, sampling flush-guard** — S4. This story stands up the recorder control surface; it does NOT deliver snapshots or apply masking config yet.
- **Runtime dynamic `import()` of the recorder chunk** — deferred (epic Out of scope). This story does the STATIC entry boundary (separate subpath export); the load-bearing, non-breaking-later part. Runtime lazy-load is a later optimization.
- **Any seam change** — S1 froze the port; this story implements it, it does not widen it.

## Acceptance criteria

- [ ] `@analytics-kit/browser` has a replay module implementing `SessionReplayPort` (`start`/`stop`/`isActive`/`getReplayId`); `start` is idempotent; `stop` halts; `isActive` tracks state.
- [ ] `rrweb` (upstream, MIT) is in `ts/packages/browser/package.json` `dependencies`. **`@posthog/rrweb-*` appears NOWHERE** in `package.json`/lockfile.
- [ ] The replay module is a SEPARATE tsup entry + `package.json` `exports` subpath; importing the base `@analytics-kit/browser` does NOT pull rrweb into the module graph (assert the base entry's dependency closure is rrweb-free).
- [ ] `provider.replay` is populated when `config.sessionReplay.enabled` is true, and is `undefined` when replay is disabled/absent — mirroring the `provider.flags` slot-population pattern.
- [ ] rrweb types never reach the neutral port or the base public surface — the `SessionReplayPort` the adapter satisfies is byte-identical to S1's, no rrweb vocabulary added.
- [ ] Gates green: `cd ts && pnpm turbo run build test typecheck lint` + `pnpm neutrality-scan` (25/25 or the current bar). The dep-add is confirmed not to trip the neutrality name-check.

## Technical notes

- **rrweb is acceptable third-party OSS (MIT), NOT a vendor leak** — architect-locked (epic Notes → "rrweb behind the adapter", 2026-07-10). It is the de-facto SOTA DOM recorder (used by PostHog, Highlight, OpenReplay); its function surface carries zero PostHog branding. It lives behind the adapter exactly the way the browser target already depends on cookies / `MutationObserver` without those leaking to the neutral surface.
- **Depend on upstream `rrweb`, NEVER `@posthog/rrweb-*`** — architect-locked (epic Notes → "rrweb behind the adapter"). The PostHog fork is a vendor-NAMED package — pulling `@posthog/rrweb-record` into the tree would put a `posthog` token in `package.json`/lockfile (a neutrality violation). Upstream is the neutral choice and is what the fork derives from. The neutrality-scan name-check reads each `package.json` `name` (`neutrality-scan.ts:226`) but does NOT scan the `dependencies` list — so `rrweb` in deps is safe; **verify at the dep-add anyway** (epic success criteria).
- **Entry-separation is load-bearing; runtime lazy-load is deferred** — architect-locked (epic Notes → "rrweb behind the adapter"). PostHog lazy-loads the recorder from a CDN for (a) bundle size and (b) remote-config-gated script naming. (b) does not apply (no remote config). (a) does — rrweb is heavy; a non-replay consumer shouldn't pay for it. Make the replay module a separate entrypoint/subpath export. Getting the entry boundary wrong LATER is breaking; deferring runtime `import()` is not.
- **De-brand reference:** `posthog-js/packages/browser/src/extensions/replay/session-recording.ts` — the rrweb-based recorder. Read it for how `record()` is invoked, the `isStarted` guard, and the snapshot event shape — then de-brand (strip PostHog naming, drop the `$snapshot`/wire vocab into adapter-internal `[WIRE]` consts, no vendor endpoint). Consult `posthog-source-guide` for how PostHog attaches/starts the recorder if the source path is unclear.
- **tsup base config is single-entry** (`ts/tsup.config.base.ts` → `entry: ['src/index.ts']`) — this story extends `ts/packages/browser/tsup.config.ts` to add the replay entry (it currently just spreads `baseTsupConfig`). Mirror the `.` `exports` block shape (`types`/`import`/`require`) for the new subpath.
- **`provider.replay` population mirrors `provider.flags`** — read how the browser flag adapter populates `provider.flags` (E12-S2) and how `provider.flags` is reached in `use-feature-flags.ts:21` (a slot cast) — the replay slot follows the identical population + exposure pattern.
- **`$snapshot`, the rrweb `eventWithTime` payload shape, any console-URL template → `[WIRE]`/adapter-internal `$`-const** — epic success criteria. Zero vendor references on any observable surface.
- No architect consult needed — every decision above is pre-resolved in the epic `## Notes`.

## Shipped
