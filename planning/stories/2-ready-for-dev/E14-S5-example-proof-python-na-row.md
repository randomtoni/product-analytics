---
id: E14-S5-example-proof-python-na-row
epic: E14-SR-session-replay
status: ready-for-dev
area: session-replay
touches: [browser, react, node]
depends_on: [E14-S4]
api_impact: additive
---

# E14-S5-example-proof-python-na-row — Example proof (Fernly) + Python N-A-by-platform row

## Why

The acceptance bars are only real once an example consumer exercises replay by config alone. Fernly (TS) proves replay works through the neutral surface: config-only enablement + sampling + masking (bar B), and a bar-A swap to a mock replay adapter with zero consumer change. This story is also where the **Python N-A-by-platform boundary is made explicit** — the `replay` slot moves from "declared-but-unimplemented, awaiting a cycle" to **N-A-BY-PLATFORM, slot permanently `None`** (a final, documented platform boundary, not a silent gap) in the parity matrix + the `provider.py` docstring.

## Scope

### In

- **Fernly (TS) replay exercise (`ts/examples/fernly/src/`)** — extend the example consumer to use replay by config alone:
  - Enable replay via `config.sessionReplay = { enabled: true, sampleRate, masking }` — no Fernly library edit (bar B). Import the replay entrypoint (`@analytics-kit/browser/replay`).
  - Exercise the port through the provider: `provider.replay?.start()` / `stop()` / `isActive()` / `getReplayId()`, and prove `getReplayId()` returns the SAME session id Fernly's captured events carry (the S3 linkage, end-to-end from a consumer's seat).
  - Exercise the React binding — replay control reachable via the provider slot (`provider.replay`), the way `useFeatureFlags` reaches `provider.flags`; taxonomy-agnostic (replay carries no props taxonomy).
  - **Bar-A proof test:** swap the replay adapter to a mock/in-memory `SessionReplayPort` implementation with ZERO change to Fernly's consumer code — the same `start`/`stop`/`getReplayId` calls resolve against the mock. Mirror the flag bar-A pattern (`flag-exercise.test.ts` swaps a `FeatureFlagPort` impl; this swaps a `SessionReplayPort` impl) — NOT the capture-SPI swap (`bar-a-adapter-swap.test.ts`).
  - **Bar-B proof test:** config-only enablement + sampling + masking — no Fernly library edit. Mirror `bar-b-config-only.test.ts`.
- **Capability-presence pin (`capability-presence.ts`/`.test.ts`)** — record session-replay's PRESENCE + SHAPE on the built exports, mirroring how flags were pinned (E12-S6):
  - Pin the port's member surface: a `Layer-1 replayPortKeys: Equals<keyof SessionReplayPort, FrozenReplayMembers>` where `FrozenReplayMembers = 'start' | 'stop' | 'isActive' | 'getReplayId'` (a 5th member flips the invariant). Add to the `Assertions` type + `CAPABILITY_PRESENCE` const.
  - The provider `replay?` slot presence is ALREADY covered by `FrozenProviderMembers` (`capability-presence.ts:59` includes `'replay'`) — do NOT re-pin it; assert the `SessionReplayPort` export + the replay entrypoint's presence.
  - **Do NOT add `replay` to `FrozenNodeMembers`** — node has no replay (server has no DOM); `FrozenNodeMembers` stays `capture`/`setTraits`/`setGroupTraits`/`flush`/`shutdown` (a false break otherwise, per the E12-S6 node-flag precedent).
- **Python N-A-BY-PLATFORM row (the explicit boundary — an acceptance criterion, not an afterthought):**
  - `python/README.md` — move the `replay` row (`:73`) from "declared-but-unimplemented slot / `None` this release" to **N-A by platform** with the one-line rationale ("Session replay records DOM mutations in a browser; a server-shaped client has no DOM to record. Documented platform omission, not a silent gap."). Update the count line (`:77–78`) from "**1 declared-but-unimplemented slot** (`replay`)" to fold `replay` into the N-A-by-platform group (5 N-A-by-platform, 0 declared-but-unimplemented slots), and the intro line (`:12`) that says the `replay?` slot "stays declared".
  - `python/src/analytics_kit/provider.py` — update the docstring (`:11`, `:31`) from "two `None` capability slots" / "`replay` capability slot — `SessionReplayPort | None`, `None` this release" to **`replay` N-A by platform (permanent) — `SessionReplayPort | None`, always `None`; no server DOM to record**, with the same rationale vocabulary the browser-only rows already use.
  - The `replay` slot stays `None` in code (no Python implementation) — this story changes only DOCUMENTATION of the disposition, from "pending" to "final platform boundary."

### Out

- **Any Python replay IMPLEMENTATION** — browser-only DOM recording; the Python slot is N-A-BY-PLATFORM (permanent). This story documents the boundary; it writes NO Python replay code.
- **New library capability** — this story writes NO `ts/packages/**` or `python/src/**` library CODE (the doc/docstring edits to `python/README.md` + `provider.py`'s docstring are documentation of an already-final disposition, not a code capability change). It is example-consumer code + tests + parity-doc updates exercising the shipped S1–S4 surface. If a bar can't be met without a library edit, that's an S1–S4 gap to route back.
- **A real-backend end-to-end `$snapshot` delivery probe** — gated by the ROADMAP development prerequisite (a live ingest key that accepts session-recording payloads). The bars in THIS story are provable against a mock replay adapter + a mock/loopback fetch seam (the PY8 precedent). The live-key probe is the separate real-stack proof.

### Development prerequisite (this story only)

- **A live analytics project + an ingest key that accepts session-recording (`$snapshot`) payloads** — gates ONLY the real-stack end-to-end delivery probe (proving snapshots actually deliver), NOT the mock-provable bar-A/bar-B/linkage exercises. Already recorded in ROADMAP `## Development prerequisites` (the E14 entry) — do NOT duplicate; this is where it binds.

## Acceptance criteria

- [ ] Fernly enables replay via `config.sessionReplay` (config only, no library edit) and its tests prove: `start`/`stop`/`isActive`/`getReplayId` through `provider.replay`; `getReplayId()` equals the session id Fernly's captured events carry (linkage end-to-end); React reaches replay via the provider slot.
- [ ] Fernly's replay bar-A proof swaps to a mock `SessionReplayPort` implementation with ZERO consumer-code change and the same replay calls resolve — a NEW replay-specific assertion (distinct from the capture-SPI swap and the flag swap). The bar-B proof shows config-only enablement + sampling + masking with no Fernly library edit (byte-identical consumer code across real↔mock runs).
- [ ] `capability-presence.ts`/`.test.ts` pin the `SessionReplayPort` member surface (`FrozenReplayMembers = 'start'|'stop'|'isActive'|'getReplayId'`, a 5th member fails) + assert the port + replay-entrypoint exports; `FrozenNodeMembers` is UNCHANGED (no `replay` added).
- [ ] **Python `replay` disposition is N-A-BY-PLATFORM (permanent)** in both `python/README.md` (row + count line + intro) and `python/src/analytics_kit/provider.py` docstring, with the browser-only-rationale vocabulary — the boundary is FINAL (no future Python cycle fills it), recorded explicitly, never a silent omission.
- [ ] Neutrality: `grep -ri posthog` across the Fernly example tree clean; `@posthog/rrweb-*` appears nowhere; `pnpm neutrality-scan` + the Python scan analog green.
- [ ] Gates green: `cd ts && pnpm turbo run build test typecheck lint` for Fernly; `cd python && uv run pytest` (the parity-doc-touching Python tests, if any assert on the matrix wording). No test hits a live backend (the real-stack `$snapshot` probe is the separate dev-prerequisite-gated proof).

## Technical notes

- **This is the epic's re-convergence + boundary-declaration point.** Fernly re-proves both bars against the finished port; the Python N-A row makes the platform boundary explicit. If a bar can't be met, the fix is back at the port (S1) or adapter (S2–S4), not a paper-over here — same discipline as E12-S6 (— architect 2026-07-10).
- **Replay bar-A is a DIFFERENT swap from capture and flags** — mirror the flag precedent (`flag-exercise.test.ts` swaps a `FeatureFlagPort` impl reached via `provider.flags`; this swaps a `SessionReplayPort` impl reached via `provider.replay`), NOT the capture `AnalyticsAdapter` SPI swap (`bar-a-adapter-swap.test.ts` pins the 18-member SPI). Replay slots into the already-proven bar-A/bar-B DISCIPLINE with no new mechanism. Assert the consumer code is byte-identical across the real-adapter and mock-adapter runs — the hard proof `SessionReplayPort` is a genuine neutral seam, not a browser-adapter-shaped leak.
- **Capability-presence pin mirrors the flag pin (E12-S6):** Layer-1 `Equals<keyof SessionReplayPort, FrozenReplayMembers>` added to `Assertions` + `CAPABILITY_PRESENCE` (`true`), importing `SessionReplayPort` from `analytics-kit`. The `replay?` provider slot is already in `FrozenProviderMembers` (`capability-presence.ts:59`) — do NOT re-pin. Node stays `replay`-free (`FrozenNodeMembers` unchanged).
- **Python N-A treatment — the PY8 category distinction (architect-locked, epic Notes → "Python N-A treatment", 2026-07-10):** PY8-S1 locked TWO N-A categories: N-A-by-platform ("server has no analog" — `page`/`reset`/browser transport) vs declared-but-unimplemented-slot ("`None`, awaiting a cycle" — where `replay` sits TODAY). This epic finishes TS replay, so replay's Python disposition moves to **N-A-BY-PLATFORM (slot permanently `None`)** — a STRONGER statement than today's "awaiting a cycle," because after this epic there is no future Python cycle that fills it; the platform boundary is FINAL, not pending. Use the same vocabulary the parity audit already uses for browser-only rows.
- **Exact edit targets (verified against the real trees):** `python/README.md:73` (the `replay` matrix row), `:77–78` (the count line "1 declared-but-unimplemented slot (`replay`)" → 0; N-A-by-platform 4→5), `:12` (the intro "`replay?` slot stays declared"); `python/src/analytics_kit/provider.py:11` ("two `None` capability slots" → one, and reclassify `replay`), `:31` (the `replay` docstring row). The slot's CODE default (`provider.py:77` `replay: SessionReplayPort | None = None`, `:95` `self.replay = None`) is UNCHANGED — only its documented disposition changes from pending to final.
- **Real-stack `$snapshot` probe is dev-prerequisite-gated** — the mock-provable bars (bar-A swap, bar-B config-only, linkage) need NO live key (PY8 precedent: unit/mock tests are self-contained). The live ingest key gates ONLY the end-to-end delivery probe. Confirm the prerequisite is already in ROADMAP `## Development prerequisites` (E14 entry) — it is; pin it here, do not duplicate it into a new prerequisite.
- No architect consult needed — every decision above is pre-resolved in the epic `## Notes`.

## Shipped
