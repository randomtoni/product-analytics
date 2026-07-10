---
id: E13-S4-ground-truth-parity-proof
epic: E13-FF-local-eval
status: ready-for-dev
area: feature-flags
touches: [node]
depends_on: [E13-S2, E13-S3]
api_impact: additive
---

# E13-S4-ground-truth-parity-proof — Ground-truth + parity proof (recipe)

## Why

Close the epic with proof that local eval is CORRECT, not just self-consistent: local-eval results must
match a real remote eval for the same inputs (the PY8 lesson — a real-stack probe must exercise the real
path, not a self-consistent mock), and the parity matrix must record local eval as a server-target
capability present in both trees, browser-absent-by-platform. The unit-level rule-matching in S1/S2/S3 is
loopback/mock-provable and carries no live-key dependency; only THIS story's ground-truth diff needs the
privileged (definition-reading) key — so it is split out and gated.

## Scope

### In

- **A ground-truth integration test (recipe), both trees** — evaluate a known flag set locally (S1/S2 in
  TS, S3 in Python) AND remotely (E12's shipped remote round-trip) against the SAME `FlagContext` inputs,
  and assert they agree: same resolved value + variant + payload per flag. This exercises the REAL
  definitions fetch + REAL remote `/flags` response, not a mock (the PY8 lesson). It needs a live
  analytics project + a **privileged (definition-reading) API key** — a development prerequisite, not a
  CC-reachable path (see the dev-prerequisite note). Structure it so the loopback/mock rule-matching
  stays green without the key and only the live diff is gated (skip-if-no-key, the PY8 precedent).
- **Negative controls (the PY8 lesson)** — the test must be able to FAIL: assert that a deliberately
  mismatched local rule (or a rollout boundary flipped) produces a DIFFERENT result from remote, so a
  passing diff is non-vacuous. A self-consistent mock that can never disagree is exactly what PY8 warned
  against.
- **A cross-tree hash-parity assertion** — the SAME pinned vector S1 and S3 already assert (do NOT mint
  a new one): tier (1) `SHA1("some-flag.some_distinct_id") == "e4ce124e800a818c63099f95fa085dc2b620e173"`;
  tier (2) the exact floats (`("simple-flag","distinct_id_0") → 0.78369637642204315`,
  `("simple-flag","distinct_id_1") → 0.33970699269954008`, variant-salt
  `("multivariate-flag","distinct_id_0") → 0.61864545379303792`); tier (3) `simple-flag` at 45% over
  `distinct_id_{0..9}` → `[false,true,true,false,true,false,false,true,false,true]`. Since S1 (TS) and S3
  (Python) each assert this in their own suite, S4 **documents it as the parity anchor** — the shared
  vector both suites bind to — rather than adding a third copy. S4's contribution is asserting the
  cross-tree IDENTITY explicitly (e.g. a recipe/comment stating both suites pin the identical vector, so
  a drift in either tree's hash fails ITS suite and the anchor is named in one place).
- **Parity-matrix update** — record feature-flag LOCAL EVAL as a server-target capability present in
  BOTH trees (TS-node + Python server), **absent-by-platform from the browser** (browsers fetch; they
  don't do local eval — a documented boundary, not a gap). The matrix lives at
  `planning/audit/capability-completeness.md` (PY8-S1 established it; also mirrored in the tree READMEs
  per PY8-S1). **Coherence note:** that matrix's feature-flags row still reads "Typed extension point,
  NOT implemented — by design" (`:175`) — it predates E12/E13. This story's remit is ADDING the
  local-eval row; but the row must not contradict the now-shipped reality (E12 remote eval + E13 local
  eval). Add the local-eval row (server-target, both trees, browser-absent-by-platform) AND, if the
  flags row still says "NOT implemented," correct THAT line to reflect flags-are-now-implemented so the
  matrix is internally coherent (feature-flags = implemented; remote eval both targets; local eval
  server-only). Do NOT expand into re-auditing other capabilities — just make the flags rows truthful.
- **Bar re-proof note** — a short confirmation in the test/recipe that both bars hold for local eval:
  bar A (an adapter that only does remote, or only local, still satisfies the one `evaluate` — local eval
  is a capability an adapter MAY add) and bar B (enabling local eval is config-only). These are already
  asserted structurally in S2/S3; S4 records them as satisfied at the epic level.

### Out

- **The evaluator / poller / resolution machinery** — S1/S2/S3 (this story proves them, does not build
  them).
- **Any seam / port change** — none; this is test + docs only.
- **CI wiring of the live-key test** — out; the gated test is skip-if-no-key locally. Whether it runs in
  CI (with a secret) is a later ops decision, not this story.
- **A dashboard / visualization of the diff** — consumer/UI territory, not library.

## Acceptance criteria

- [ ] A ground-truth test evaluates a known flag set LOCALLY and REMOTELY against the same inputs and
      asserts per-flag agreement (value + variant + payload). The KEY-LESS layer exercises the real
      definitions fetch + real remote response through a **loopback `http.server`** (a real socket, the
      PY8-S3 precedent — not a mock), and is fully green with no external setup; the LIVE layer
      (diffing against a real backend's own bucketing via the privileged key) SKIPS cleanly — not fails —
      when the key is absent.
- [ ] Negative controls prove the diff is non-vacuous: a deliberately-wrong local rule or flipped rollout
      boundary yields a DIFFERENT result from remote, so the passing agreement is meaningful (the PY8
      lesson — the test can fail).
- [ ] A cross-tree hash vector is asserted in both suites (TS + Python) pinning identical bucketing; a
      drift in either tree's hash fails its suite.
- [ ] The parity matrix records feature-flag local eval as present in both server trees, browser-absent-
      by-platform (a documented final boundary, not pending).
- [ ] Both acceptance bars are recorded as satisfied for local eval: bar A (remote-only or local-only
      adapter still satisfies the one `evaluate`) and bar B (config-only enablement).
- [ ] Neutrality: no vendor token in the test/recipe/matrix copy on any observable surface;
      `pnpm neutrality-scan` (TS) + the Python neutrality-scan analog green.
- [ ] Gates green in both trees: `pnpm --filter @analytics-kit/node build test typecheck lint` and
      `cd python && uv run pytest && uv run ruff check && uv run mypy`; the key-less path is fully green.

## Technical notes

- **THREE test layers, only the third is key-gated (pin the narrowest path per the PY8-S3 precedent):**
  the PY8-S3 real-stack probes used a **local loopback `http.server`** (stdlib, ephemeral port) as the
  REAL transport — NO live vendor endpoint, NO live key. Mirror that here so the CC-reachable GREEN path
  is as strong as possible without external setup:
  1. **Loopback ground-truth (CC-reachable, KEY-LESS, the primary green path):** stand up a loopback
     server that serves BOTH a canned-but-realistic **definitions** payload (to the S1/S3 poller) AND a
     canned remote `/flags` response (to the shipped `roundTrip`/`_round_trip`) for the SAME
     `FlagContext` inputs. Evaluate locally and remotely THROUGH THE REAL TRANSPORT and assert per-flag
     agreement. This satisfies the PY8 "real path, not a self-consistent mock" lesson at the transport
     layer without a key — the definitions AND the remote response cross a real socket.
  2. **Cross-tree hash anchor (CC-reachable, KEY-LESS):** the shared vector named above.
  3. **Live privileged-key ground-truth (GATED, skip-if-no-key):** the ONLY part needing a live
     analytics project + privileged (definition-reading) key — it diffs local eval against a REAL
     backend's OWN bucketing/definitions (the true correctness anchor for the hash against production,
     which loopback canned data cannot prove). Structure it `skip-if-no-key` (the PY8 precedent) so its
     absence SKIPS (not fails); layers 1–2 stay fully green key-less.
  Confirm the prerequisite is already in ROADMAP `## Development prerequisites` (added when E13 was
  drafted) — do NOT duplicate the entry.
- **The PY8 lesson is the whole point (— E12-S4 / PY8 precedent):** a real-stack probe must exercise the
  REAL path, not a self-consistent mock. Local eval that only ever compares against its own mocked remote
  response proves nothing. The negative controls (the test CAN fail) are mandatory — a diff that can
  never disagree is the exact failure mode PY8 caught (the real transport vs. the mock returning
  self-consistent data).
- **Hash parity is the load-bearing invariant across BOTH trees AND the backend (— posthog-source-guide
  2026-07-10):** the ground-truth diff is really a test that S1/S3's bucketing matches the backend's. If
  the diff disagrees on a rollout/variant flag, the hash is wrong — escalate to `architect` on the exact
  backend hash shape before assuming a test bug.
- **Parity matrix location:** the PY cycle established a parity matrix (feature-flags present in both
  trees; session-replay N/A-by-platform on Python). The builder locates it (likely under `planning/` or a
  tree README) and adds the local-eval row: server-target, both trees, browser-absent-by-platform. This
  is the same shape as the session-replay N/A-by-platform entry, inverted (server-only vs browser-only).
- **This story is test + docs only — ZERO src/port change.** It consumes S2 + S3; both must be done
  first (`depends_on`). No new public API, no seam surface.

> Reviewer suggestion (2026-07-10): `test_flag_parity.py` asserts `send_cohorts` via the private `poller._url` on a throwaway poller (white-box) rather than over the loopback socket — could record the GET path in the loopback `do_GET` for an over-the-wire assertion.
> Reviewer suggestion (2026-07-10): Add a one-line comment distinguishing the fallback-fired layer-1 test from its zero-POST complement.

## Shipped

> Captured by `implement-epics` on 2026-07-10.

- **Files added:** `python/tests/test_flag_parity.py`, `ts/packages/node/src/flags/local-parity.test.ts`
- **Files changed:** `planning/audit/capability-completeness.md` (Feature-flags row → IMPLEMENTED; Session-replay row unchanged), `python/README.md` + `ts/README.md` (capability matrix `flags?` → implemented)
- **New public API:** none — audit/proof only. **ZERO library-src edits** (`ts/packages/**` non-test + `python/src/**` untouched — audit-not-patch confirmed by reviewer via tracked+untracked git diff).
- **Tests added:** TS `local-parity.test.ts` (10) + Python `test_flag_parity.py` (10 + 1 skip-if-no-key). Three layers: (1) LOOPBACK GROUND-TRUTH over a REAL socket (TS `node:http` `listen(0)`; Python `HTTPServer(127.0.0.1:0)` daemon), REAL default transport, definitions GET + remote `/flags` POST both cross the socket; (2) the cross-tree hash anchor (S1's exact 3-tier vector, byte-identical across both trees' suites); (3) the live-privileged-key diff (structured `skipif` — clean skip, not a silent pass). Negative controls: zero-POST for local-decidable (call-count asserted), wrong-remote (local≠remote), flipped-0%-rollout.
- **Commit:** `main` (message = story title)
- **Reviewer notes:** ship-ready, no critical, first review. Reviewer **PROVED the ground-truth diff bites** — mutated the pinned `multivariate-flag: second-variant→first-variant` in each tree → BOTH suites FAILED (`expected 'second-variant' to be 'first-variant'`), decisive non-vacuity (the PY8 "real path, prove it can fail" lesson). Confirmed real sockets (not self-consistent mocks), the cross-tree anchor is ONE shared identity (not two drifting copies), negative controls bite on observable state, the live-key layer cleanly skips, the matrix correction is truthful (Session-replay row left unchanged — E14), and ruled the README edits IN-SCOPE (an audit story keeps capability docs truthful the instant a capability ships; surgical `flags?`-only flips, neutral, Python 10+4+1=15 accounting consistent). 2 non-blocking suggestions. `send_cohorts` on the wire + `early_exit` deferral confirmed.
- **Cross-story seams exposed / capability note:** **feature-flags is now COMPLETE — remote (E12) + local (E13), across both trees, at cross-tree HASH PARITY.** Both bars satisfied for local eval (A: local-vs-remote is adapter-internal behind the unchanged `evaluate` — zero consumer change; B: config-only local-eval adoption). E13 closes the flags area. The privileged definition-reading key remains the ONLY gated proof (live diff, layer 3); the loopback + cross-tree layers are the CC-reachable green path.
