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
- **A cross-tree hash-parity assertion** — a shared known vector (the SAME `(flag_key, distinct_id)` →
  float) asserted in both the TS and Python suites, pinning that S1 and S3 bucket identically. (If S1/S3
  already assert this vector, S4 documents it as the parity anchor rather than duplicating.)
- **Parity-matrix update** — record feature-flag LOCAL EVAL as a server-target capability present in
  BOTH trees (TS-node + Python server), **absent-by-platform from the browser** (browsers fetch; they
  don't do local eval — a documented boundary, not a gap). Update wherever the parity matrix lives
  (the doc PY-cycle established; the builder locates it — likely `planning/` or a tree README).
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
      asserts per-flag agreement (value + variant + payload). It exercises the real definitions fetch +
      real remote response when the privileged key is present, and SKIPS cleanly (not fails) when it is
      absent — the loopback/mock rule-matching stays green key-less.
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

- **DEVELOPMENT PREREQUISITE — gated on a privileged (definition-reading) key (— epic, ROADMAP
  `## Development prerequisites`):** the ground-truth diff needs a live analytics project + a privileged
  key to read real definitions AND run a real remote eval to diff against. This gates ONLY this story's
  real-stack proof; the unit-level rule-matching in S1/S2/S3 is loopback/mock-provable and needs no key.
  Structure the live diff as skip-if-no-key (the PY8 precedent) so the CC-reachable path — loopback/mock
  proof + the cross-tree hash vector — is fully green without external setup, and the live-key ground-
  truth is the only gated part. Confirm the prerequisite is already in ROADMAP (added when E13 was
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

## Shipped

<!-- Empty at draft. /implement-epics fills this when the story moves to stories/5-done/. -->
