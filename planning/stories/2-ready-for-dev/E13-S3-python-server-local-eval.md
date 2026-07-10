---
id: E13-S3-python-server-local-eval
epic: E13-FF-local-eval
status: ready-for-dev
area: feature-flags
touches: [node]
depends_on: [E13-S2]
api_impact: additive
---

# E13-S3-python-server-local-eval — Python server local eval (evaluator + poller + fallback)

## Why

Parity: the Python server tree must reach every capability the TS surface exposes. This is the Python
analog of S1+S2 — the in-process evaluator + definition poller + local/remote resolution/fallback,
de-branded from `posthog-python`, satisfying the SAME frozen `FeatureFlagPort` behind the SAME
unchanged `evaluate`. Local eval is the Python-central weighting of feature-flags, so Python advances
alongside node here, server-shaped, at parity by shared contract.

## Scope

### In

- **A pure in-process evaluator** (`python/src/analytics_kit/flags/local/` — a new submodule,
  adapter-internal, nothing added to the public `analytics_kit` exports in this story) de-branded from
  `posthog-python`'s local-eval path, at parity with S1:
  - The SAME rollout-hash bucketing algorithm as S1 — `SHA1(flag_key "." bucketing_value [+ salt])`,
    first 15 hex nibbles → int → `/ 0xfffffffffffffff` → `[0,1)` float, no salt for rollout, `'variant'`
    salt for variants. This MUST match the TS S1 hash and the backend bit-for-bit (see Technical notes).
  - The SAME property operators, condition-group/variant matching, and cohort AND/OR matching as S1.
  - The SAME two inconclusive signals (`InconclusiveMatchError` analog for missing-property/continuity/
    bad-matcher; `RequiresServerEvaluation` analog for static-cohort), neutral-named, thrown out of the
    evaluator and caught by the resolution layer.
- **A definition poller** — fetch flag definitions + group-type mapping + cohort map from the
  config-supplied definitions endpoint, authenticated by the privileged credential; blocking I/O behind
  the same posture as the E12 remote adapter (**no asyncio** — a plain blocking round-trip, a
  background poll driven by a thread/timer with an explicit `stop()`, mirroring how the query/flag
  adapters hide blocking I/O). Injectable transport (mirror the E12 flag `FlagTransport`) so tests never
  hit a live backend. Dedup concurrent loads; `stop()` halts the poll thread cleanly (the E12-S4
  daemon-thread-leak lesson: tests must not leak the poll thread — `stop()` in teardown or a
  non-daemon join).
- **Local/remote resolution + fallback in `HttpFlagAdapter.evaluate`** (`python/src/analytics_kit/
  flags/adapter.py`) — the Python analog of S2, a strategy branch behind the SYNCHRONOUS `evaluate`:
  local-first, fall back to E12's shipped `_round_trip` (reuse it, do NOT fork a second client), merge
  per-flag into one coherent `_Snapshot`/`FlagSet` with the EXISTING `FlagReason` union. `evaluate`
  stays sync-by-design (a bare `FlagSet`, never a coroutine) — parity is the method surface + behavior,
  not async-ness.
- **`only_evaluate_locally` / `strict_local_evaluation` as adapter config** on `FlagClientConfig`
  (`python/src/analytics_kit/flags/config.py`) + `definitions_endpoint` + a privileged-credential field
  + `poll_interval` — Pydantic fields, NEVER on the neutral `FlagContext`/port. Effective value =
  `only_evaluate_locally if set else strict_local_evaluation else False`. Factory wiring
  (`flags/factory.py` + `create_flag_client` + the `create_server_analytics(cfg).flags` slot): a config
  with a definitions endpoint + privileged credential selects the local-capable adapter; otherwise
  remote-only exactly as E12 shipped; unkeyed ⇒ `FlagNoop`. Config-only (bar B).
- **Tests (`python/tests/`)** — all mock/loopback (no live backend, no live key), at parity with S1+S2:
  the hash matches a known vector (and, ideally, the SAME vector S1 asserts, to lock cross-tree
  parity); operators; rollout/variant bucketing; cohort AND/OR; the two inconclusive signals distinct;
  local-first resolves without a round-trip; inconclusive falls back to the shipped `_round_trip`;
  `only_evaluate_locally` suppresses fallback; local-vs-remote indistinguishable (same `degraded`/
  `reason`); `distinct_id`-required still raises pre-eval; `on_change` fires once; the poll thread does
  NOT leak (the deterministic with/without-file green check).

### Out

- **TS node work** — S1/S2 (this is the Python analog).
- **Ground-truth parity proof against a real remote eval** — S4 (needs the privileged key). This story
  asserts the CONTRACT + a cross-tree hash vector, not a live-backend diff.
- **Browser / DOM concerns** — Python is server-shaped; the browser has no local mode (the epic's
  server-only weighting). No browser analog.
- **Any seam / port / `FlagContext` / `FlagSet` / `FlagReason` change** — parity is against the frozen
  S1-pinned `ports.py` port. `only_evaluate_locally`/`strict_local_evaluation`/`poll_interval`/
  `definitions_endpoint` are ADAPTER CONFIG on `FlagClientConfig`, never neutral port surface.
- **`$feature_flag_called` auto-capture** — out of the epic.
- **A recursive JSON-schema payload type** — flat ceiling, parity with TS.

## Acceptance criteria

- [ ] The Python evaluator matches S1's rollout/variant hash exactly — a known-vector test asserts the
      SAME float for the same `(flag_key, distinct_id)` S1 uses (cross-tree parity locked in test), and
      rollout at 0%/100% and variant band selection behave identically to TS.
- [ ] The Python adapter satisfies the frozen S1 `FeatureFlagPort` Protocol unchanged; `evaluate` stays
      SYNCHRONOUS (a bare `FlagSet`, no `await`, no coroutine — the locked no-asyncio posture); local
      eval is a strategy branch behind it with ZERO seam/port change.
- [ ] Local-first resolves a flag without a round-trip (assert the injected transport was not called for
      it); an inconclusive flag falls back to the SHIPPED `_round_trip` (not a second client) and the
      merged snapshot carries both; `only_evaluate_locally` suppresses the fallback.
- [ ] A locally-resolved flag and a remotely-resolved flag are indistinguishable: same `degraded`/
      `reason`, same `is_enabled`/`get_flag`/`get_payload`/`get_all` behavior. A local failure reads
      identically to a remote failure. The EXISTING `_Snapshot`/`FlagReason` union is reused — no new
      reason.
- [ ] `distinct_id`-required still raises a neutral error pre-eval; `on_change` fires exactly once;
      enabling/tuning local eval is config-only (bar B) via `FlagClientConfig` fields.
- [ ] The poll thread does not leak in the test suite (the E12-S4 daemon-thread lesson: `stop()` in
      teardown; the suite is deterministic green with and without this file).
- [ ] Neutrality: `grep -ri posthog python/src/analytics_kit` clean (save the architect-locked
      provenance-comment exemption); wire/endpoint/credential/hash-constant tokens confined to
      `_WIRE_*`/adapter-internal; the Python neutrality-scan analog green.
- [ ] Gates green: `cd python && uv run pytest && uv run ruff check && uv run mypy`; all tests
      mock/loopback, never a live backend or live key.

## Technical notes

- **BLOCKING PRECONDITION — `posthog-python` must be cloned first (builder: verify before writing
  code).** This adapter de-brands from `posthog-python`'s local-eval path
  (`feature_flag_evaluations.py` + `flag_definition_cache.py` — the definition cache + `match_property`
  cohort/rollout evaluation). Per CLAUDE.md, `posthog-python` (PostHog/posthog-python) is cloned beside
  `posthog-js/` at the repo root as a development prerequisite. If it is absent when the builder starts,
  that is a hard stop — clone it (or route to the user) before porting; do NOT invent the local-eval
  rule/hash shape without the reference. `posthog-source-guide` reads the `posthog-js/` checkout, so it
  can inform the neutral SHAPE (grounded in the node local evaluator) but cannot confirm
  `posthog-python`'s exact structure until the clone lands. — E12-S4 precedent.
- **The hash MUST match S1 and the backend bit-for-bit (— posthog-source-guide 2026-07-10):** this is
  the load-bearing parity invariant. Assert the same known vector S1 asserts. Any divergence means
  local and remote (and TS and Python) disagree for the same actor. Port the algorithm verbatim; strip
  only vendor naming. Consider `architect` if the exact backend hash shape is in any doubt.
- **Parity is by shared contract, not shared code (— CLAUDE.md):** this satisfies the SAME
  `FeatureFlagPort` S1 pinned in `python/src/analytics_kit/ports.py` — it does NOT import from `ts/`,
  and `ts/` does not import from here. Implement against the port, server-shaped, idiomatic Python.
- **`evaluate` is SYNCHRONOUS in Python (parity clarification, — matches E12-S4's locked decision):**
  the round-trip AND the poll are blocking behind sync surfaces; no asyncio anywhere. "Parity with S2"
  is the same method surface + behavior (once-fire `on_change`, `distinct_id`-required, `degraded`/
  `reason`, local-first-then-remote), NOT the same async-ness. The tests must state `evaluate` is
  sync-by-design so a future reader does not "fix" it toward asyncio.
- **Fallback reuses E12's `_round_trip` exactly (— architect 2026-07-10, epic Notes):** when local eval
  can't resolve a flag, call the SHIPPED remote machinery in `adapter.py`, so a partly-local-partly-
  remote result is one coherent snapshot. Do NOT fork a second remote client. E12-S4's `Shipped` note
  confirms the remote path is a cleanly separable strategy inside the adapter.
- **Config knobs on `FlagClientConfig`, never the seam (— architect 2026-07-10, epic Notes):** add
  `definitions_endpoint`/privileged-credential/`poll_interval`/`only_evaluate_locally`/
  `strict_local_evaluation` as Pydantic fields on `FlagClientConfig` (`flags/config.py`), read by the
  factory. The neutral `FlagContext`/port and the seam `FlagsConfig.bootstrap` stay untouched.
- **Local eval reads person/group props straight off `FlagContext` (— architect 2026-07-10, epic
  Notes):** the E12 `FlagContext` TypedDict already carries `person_properties`/`group_properties`/
  `groups`/`distinct_id` — exactly what the in-process matcher needs. Zero seam change for the same
  reason as TS.
- **Poll-thread hygiene (— E12-S4 lesson):** the S4 daemon-`BatchConsumer`-thread leak turned the suite
  red via the reliability assertion. The poll thread here MUST be stoppable and stopped in test
  teardown (or joined non-daemon); prove the suite is deterministic green with and without this file.
- **E13's load-bearing invariant:** ZERO seam/port change. This is the regression check that E12's port
  shape holds across BOTH trees. A needed port/context change is an E12-was-wrong escalation.

## Shipped

<!-- Empty at draft. /implement-epics fills this when the story moves to stories/5-done/. -->
