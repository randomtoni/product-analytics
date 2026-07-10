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
- **Separate tsup entrypoint** — the replay module is its own subpath export of `@analytics-kit/browser` (e.g. `@analytics-kit/browser/replay`). **NOTE: this is the FIRST multi-entry tsup config + the FIRST subpath export in the whole monorepo** — all four packages are single `.`-entry today, so there is no in-repo precedent to copy; establish the pattern carefully (getting the entry boundary wrong later is breaking):
  - Add a second `entry` to `ts/packages/browser/tsup.config.ts` — it currently is `export default defineConfig({ ...baseTsupConfig })` and `baseTsupConfig.entry` is `['src/index.ts']` (`tsup.config.base.ts`). Override `entry` to include BOTH `src/index.ts` and the replay entry (e.g. `src/replay/index.ts`) rather than spreading the base's single entry. This emits `dist/index.*` AND `dist/replay.*` (with `dts: true` → `dist/replay.d.ts`/`.d.mts` too).
  - Add the subpath to `package.json` `exports` (with `types`/`import`/`require` conditions, mirroring the existing `.` entry block at `package.json:8-12`).
  - Importing the base `@analytics-kit/browser` must NOT pull rrweb into the graph — verify the base bundle (`dist/index.js`/`.mjs`) stays rrweb-free. There is no existing bundle-inspection test to copy; the check is new (assert the base `dist/index.*` does not contain an rrweb import/token, e.g. by reading the built base bundle in a test — the replay module must be reachable ONLY from the replay entry, never transitively from `src/index.ts`).
- **Populate `provider.replay`** — mirror the `attachFlags` precedent exactly: `browser/src/create-analytics.ts:102` (`attachFlags`) guards on `adapter instanceof BrowserAdapter`, then assigns `analytics.flags = new FlagClient({...})`. Add a sibling `attachReplay(analytics, adapter, config)` called from `createAnalytics` (`:125`, right after `attachFlags`) that, when `config.sessionReplay?.enabled` is set AND the adapter is a `BrowserAdapter`, assigns `analytics.replay = <the replay port impl>`. Absent/disabled/unkeyed (NoopAdapter) → `replay` stays `undefined`. This is config-only, fills the existing optional `replay?` slot, and leaves the frozen-15 `keyof` pin untouched (same discipline as `attachFlags`).
- **Verify the neutrality-scan dep dimension** — after adding `rrweb`, run `pnpm neutrality-scan` and confirm `rrweb` in `dependencies` does not trip the name-check (`scanPackageAndFileNames` reads `package.json` `name` at `neutrality-scan.ts:229`, NOT the `dependencies` list — no dimension reads deps or the lockfile). See the Technical note "what the scan actually does re: rrweb" for the precise (and slightly different from the epic's framing) behavior, including the scan blind-spots this story must respect.

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
- [ ] Gates green: `cd ts && pnpm turbo run build test typecheck lint` + `pnpm neutrality-scan` (25/25 or the current bar). The `rrweb` dep-add is confirmed not to trip the scan (deps are unscanned). NOTE: green does NOT certify the replay `dist/replay.*` bundle — it is not scanned (see Technical notes); the `@posthog/rrweb-*` ban is honored by discipline, not by the scan.

## Technical notes

- **rrweb is acceptable third-party OSS (MIT), NOT a vendor leak** — architect-locked (epic Notes → "rrweb behind the adapter", 2026-07-10). It is the de-facto SOTA DOM recorder (used by PostHog, Highlight, OpenReplay); its function surface carries zero PostHog branding. It lives behind the adapter exactly the way the browser target already depends on cookies / `MutationObserver` without those leaking to the neutral surface.
- **Depend on upstream `rrweb`, NEVER `@posthog/rrweb-*`** — architect-locked (epic Notes → "rrweb behind the adapter"). Upstream `rrweb` (`rrweb-io/rrweb`, MIT) is the neutral choice and is what the PostHog fork derives from. Add it to `ts/packages/browser/package.json` `dependencies` (sibling of `fflate`).
- **What the neutrality-scan ACTUALLY does re: rrweb (corrects the epic's "lockfile/deps" framing — refine 2026-07-10):** the scan has NO dimension that reads `dependencies` or the lockfile. `scanPackageAndFileNames` reads only each `package.json` `.name` (`neutrality-scan.ts:229`, not `:226` — `:226` is the path decl) and walks `package.json` FILE PATHS (skipping `node_modules`, `dist`, `.turbo` — `walk`, `:68`). Consequences the builder must know:
  - **`rrweb` in `dependencies` is safe** — it is never read by any dimension. Confirmed against the scan; run `pnpm neutrality-scan` at the dep-add to re-confirm 25/25 (or the current bar).
  - **A `@posthog/rrweb-*` dep would NOT be caught by the scan either** — the epic's claim that "the vendor-named fork would put a `posthog` token in the lockfile" that the scan flags is FALSE: the scan reads neither the lockfile nor the deps list, and `node_modules` is walk-skipped. The `@posthog/rrweb-*` ban is therefore a **discipline/review invariant, NOT a scan-enforced gate** — the builder MUST honor it by choice; do not rely on the scan to catch a slip. (The only way the scan would catch a `@posthog/*` fork is if bundled fork internals shipped a literal `posthog` string VALUE into a SCANNED `dist` bundle — see the next bullet for why the replay entry isn't scanned, making even that net unreliable.)
  - **The replay entry's `dist` is a scan BLIND SPOT.** `scanJsBundles`/`scanDeclarationBundles` hardcode `['index.js','index.mjs']` / `['index.d.ts','index.d.mts']` per package (`:105`, `:193`) — they do NOT read `dist/replay.*`. So the js-bundle vendor-VALUE net that certifies the base bundle does NOT cover the new replay entry. This is a known, accepted gap for THIS story (the neutral-surface guarantee is about what the base import exposes; rrweb's own wire vocab is confined behind the adapter regardless). If a later hardening slice wants the replay entry certified too, `scanJsBundles`/`scanDeclarationBundles` would extend their per-package extension list — flagged, not required here. Do NOT silently assume `pnpm neutrality-scan` green means the replay bundle is vendor-clean; it was never scanned.
- **Entry-separation is load-bearing; runtime lazy-load is deferred** — architect-locked (epic Notes → "rrweb behind the adapter"). PostHog lazy-loads the recorder from a CDN for (a) bundle size and (b) remote-config-gated script naming. (b) does not apply (no remote config). (a) does — rrweb is heavy; a non-replay consumer shouldn't pay for it. Make the replay module a separate entrypoint/subpath export. Getting the entry boundary wrong LATER is breaking; deferring runtime `import()` is not.
- **De-brand reference:** `posthog-js/packages/browser/src/extensions/replay/session-recording.ts` — the rrweb-based recorder. Read it for how `record()` is invoked, the `isStarted` guard, and the snapshot event shape — then de-brand (strip PostHog naming, drop the `$snapshot`/wire vocab into adapter-internal `[WIRE]` consts, no vendor endpoint). Consult `posthog-source-guide` for how PostHog attaches/starts the recorder if the source path is unclear.
- **tsup base config is single-entry** (`ts/tsup.config.base.ts` → `entry: ['src/index.ts']`) — this story OVERRIDES `entry` in `ts/packages/browser/tsup.config.ts` (which currently just spreads `baseTsupConfig`) to list both `src/index.ts` and the replay entry. Mirror the existing `.` `exports` block (`package.json:8-12`, `types`/`import`/`require`) for the new subpath. This is the monorepo's first multi-entry package — no in-repo precedent, so validate the emitted `dist/replay.*` + the base-stays-clean assertion carefully.
- **`provider.replay` population mirrors `attachFlags` (verified real):** `browser/src/create-analytics.ts:102` (`attachFlags`, `instanceof BrowserAdapter` guard → `analytics.flags = new FlagClient(...)`), called at `:125`. Add a sibling `attachReplay` called right after. The slot is reached the same way `provider.flags` is read in the React binding — `use-feature-flags.ts:21` casts `(client as RootAnalytics<TX>).flags as FeatureFlagPort<TX> | undefined`; replay follows the identical cast (S5 exercises the React path).
- **`$snapshot`, the rrweb `eventWithTime` payload shape, any console-URL template → `[WIRE]`/adapter-internal `$`-const** — epic success criteria. Zero vendor references on any observable surface.
- No architect consult needed — every decision above is pre-resolved in the epic `## Notes`.

## Shipped

> Captured by `implement-epics` on 2026-07-10.

- **Files changed:** `ts/packages/browser/package.json` (upstream `rrweb ^2.1.0` dep + the `./replay` exports subpath), `tsup.config.ts` (two-entry `{index, replay}` + **`splitting: true`**, browser-pkg only), `src/browser-adapter.ts` (`getReplaySessionId()` — the S3 hook, a pure read of `lastSeenSessionId`), `src/create-analytics.ts` (+ `.test.ts`) (`attachReplay`), `ts/pnpm-lock.yaml`
- **Files added:** `src/replay-recorder.ts` (the thin rrweb-FREE shell — `ReplayRecorder implements SessionReplayPort` + `attachReplay`), `src/replay/index.ts` (the rrweb BODY — the ONLY rrweb importer → `dist/replay.*`), + 3 test files (19 tests)
- **New public API:** `@analytics-kit/browser/replay` subpath export (the recorder body). The base `@analytics-kit/browser` surface is unchanged (the `provider.replay` slot from S1). `SessionReplayPort` NOT widened.
- **Tests added:** `replay-recorder.test.ts` (11 — shell start/stop/isActive/getReplayId, attach), `replay/index.test.ts` (rrweb body via mocked `record()`), `replay-bundle-separation.test.ts` (5 — base `dist/index.*` rrweb-import-free; **reviewer mutation-verified: a static `./replay` import → chunk-hoist detected; a direct rrweb import → base assertions red**).
- **Commit:** `main` (message = story title)
- **Reviewer notes:** ship-ready, no critical, first review. The AC#3-vs-AC#4 fork (base bundle rrweb-free + synchronous `provider.replay`) was resolved via a **shell/body split**: a thin rrweb-free `ReplayRecorder` shell statically imported into the base graph (synchronous attach) + the rrweb body behind the `src/replay/index.ts` tsup entry, reached ONLY via a dynamic `import('./replay')` in the shell's `start()`. **`splitting: true`** (browser-pkg only) is load-bearing — the builder empirically proved a dynamic import under `splitting: false` INLINES rrweb into CJS `dist/index.js`; reviewer ruled it correct + non-regressive (no `chunk-*`, other packages untouched). Base bundle independently grep-verified rrweb-free (orchestrator + reviewer). `@posthog/*` absent (upstream `rrweb` only). `isActive()` honest (false until the async rrweb load resolves — the posthog `isStarted` model). 2 suggestions captured.
- **Cross-story seams exposed:** **S3** — swap `BrowserAdapter.getReplaySessionId()` from the `lastSeenSessionId` placeholder to the shared `SessionIdManager` read, and add an ADDITIVE `onRotate?` to `ReplayRecorderOptions` (the options object was shaped to grow) so the recorder re-keys on rotation (stop+start against the new id); `getReplayId()` needs no change. **S4** — the recorder buffers rrweb events on `ReplayRecordingHandle.buffer` (per-recording, un-capped-until-S4, documented — S4 owns drain/flush over its OWN delivery path reusing `ingestHost`+fixed replay path + adapter fetch/gzip, NOT the capture queue); masking (`maskAllInputs`/`maskTextSelector`/`blockSelector`) threads into `startRecording()`'s `record({...})` options; **`attachReplay` must re-add the `config` param it currently drops** (the reviewer's flag — it mirrors `attachFlags` which carries `config`; S4 needs it for masking/sampling). **Follow-up (captured):** add a `chunk-*`-free assertion to the bundle test to close the transitive-via-chunk gap directly.

## Follow-up

> Improvement pass (2026-07-10, commit `E14 improvement pass`).
- **`chunk-*`-free bundle assertion added** — `replay-bundle-separation.test.ts` now reads the real `dist/` list and asserts NO `chunk-*` files, catching a transitive rrweb-hoist DIRECTLY (not just incidentally via the base-graph check). Reviewer empirically confirmed it bites: a probe where two entries share a static import produced `chunk-*` artifacts. (Minor note left: the invariant holds because these entries share no static code — `splitting: true` doesn't universally imply zero chunks.)
- Not addressed (already done): the S2 reviewer's "`attachReplay` must re-add `config`" — S4 re-added it. No action.
