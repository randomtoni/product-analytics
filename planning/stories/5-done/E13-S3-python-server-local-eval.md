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
  - The SAME rollout-hash bucketing algorithm as S1 — `SHA1(f"{flag_key}.{bucketing_value}{salt}")`,
    first **15** hex nibbles → `int(..., 16)` → `/ __LONG_SCALE__` → `[0,1]` float (top-inclusive), no
    salt (`""`) for rollout, the literal `"variant"` salt (suffix, no separator) for variants; rollout
    inclusion `_hash <= rollout_percentage / 100` (`/100`, float); variant bands cumulative half-open
    `[value_min, value_max)` in declared order. `__LONG_SCALE__ = float(0xFFFFFFFFFFFFFFF)` (15 f's) —
    keep it a **FLOAT** and let `int / float` yield a float64; do NOT use `Decimal` or integer division
    (the Python-specific drift trap — the numerator is a 60-bit int, the division must be float64 to
    match TS's `parseInt / LONG_SCALE`). This MUST match the TS S1 hash and the backend bit-for-bit — and
    it does: `feature_flags.py:79-82` (`_hash`) + `:14` (`__LONG_SCALE__`) are byte-identical to S1's
    reference (confirmed 2026-07-10). Assert the SAME pinned vector S1 asserts (see Technical notes).
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
  flags/adapter.py`) — the Python analog of S2, a strategy branch behind the SYNCHRONOUS `evaluate`
  (`adapter.py:236`): local-first, fall back to E12's shipped `_round_trip(context)` (`adapter.py:284`,
  reuse it, do NOT fork a second client). Like S2, merge at the MAP level: the shipped `_round_trip`
  returns a `_Snapshot` with a SINGLE snapshot-level `reason`/`degraded` (`adapter.py:91-138`), and its
  lower `_fetch(context)` (`adapter.py:305`) yields the `(flags, payloads)` tuple — build locally-resolved
  `{flags, payloads}`, collect inconclusive keys as the fallback set, layer the remote maps OVER the
  still-unresolved keys, wrap once in a `_Snapshot` with the EXISTING `FlagReason` union — NO per-flag
  reason, NO new reason value (the `_Snapshot.reason` stays snapshot-uniform, `adapter.py:135-138`).
  `evaluate` stays sync-by-design (a bare `FlagSet`, never a coroutine, signature UNCHANGED incl. its
  `options` param) — parity is the method surface + behavior, not async-ness.
- **`only_evaluate_locally` / `strict_local_evaluation` as adapter config** on `FlagClientConfig`
  (`python/src/analytics_kit/flags/config.py` — currently `{key, flag_endpoint, bootstrap, taxonomy,
  transport}` with `model_config = ConfigDict(extra="forbid", arbitrary_types_allowed=True)`): ADD
  `definitions_endpoint: str | None`, a role-named privileged-credential field (e.g.
  `definitions_key: str | None` — never `personal_api_key`), `poll_interval: float | None`,
  `only_evaluate_locally: bool | None`, `strict_local_evaluation: bool | None` — Pydantic fields, NEVER
  on the neutral `FlagContext`/port. (`extra="forbid"` means these MUST be real fields or a local-eval
  config raises — do not rely on passthrough.) Effective value =
  `only_evaluate_locally if only_evaluate_locally is not None else (strict_local_evaluation or False)`
  (the reference default `only_evaluate_locally ?? strict_local_evaluation ?? False`). Factory wiring
  (`flags/factory.py:24` `create_flag_client` + the `create_server_analytics(cfg).flags` slot,
  `server/__init__.py`'s `_attach_flags`): a config with a definitions endpoint + privileged credential
  selects the local-capable adapter; otherwise remote-only exactly as E12 shipped; unkeyed ⇒ `FlagNoop`.
  **Same local-only edge as S2:** `key` + `definitions_endpoint` + privileged credential WITHOUT a
  `flag_endpoint` (an `only_evaluate_locally` posture) must select the local-capable adapter, not the
  no-op — the shipped factory only checks `key is None or flag_endpoint is None → FlagNoop`
  (`factory.py:31`), so relax that so a local-capable config is honored. Config-only (bar B).
- **Tests (`python/tests/`)** — all mock/loopback (no live backend, no live key), at parity with S1+S2:
  the hash matches the SAME pinned three-tier vector S1 asserts (NOT merely "a" vector — cross-tree
  parity requires the identical vector, see Technical notes); operators; rollout/variant bucketing;
  cohort AND/OR; the two inconclusive signals distinct;
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

- **De-brand references — the RIGHT file per concern (verified 2026-07-10, `posthog-python` IS cloned
  at the repo root):** `posthog-python` is present, so the E12-S4-style "hard stop if absent" no longer
  applies — but the builder should still confirm the checkout before writing. Point each ported piece at
  its actual source:
  - **Hash + evaluator** → `posthog-python/posthog/feature_flags.py`: `_hash` (`:79-82`),
    `__LONG_SCALE__ = float(0xFFFFFFFFFFFFFFF)` (`:14`, 15 f's — byte-identical to S1's `LONG_SCALE`),
    `get_matching_variant` (`:85`), `variant_lookup_table` (`:93`), `match_property` (`:466`),
    `match_property_group` (`:693`), `InconclusiveMatchError` (`:59`). (NOT `feature_flag_evaluations.py`
    — the hash/`match_property` do NOT live there.)
  - **Definition poller** → `posthog-python/posthog/poller.py`: a generic `Poller(threading.Thread)`
    with `stop()` + a `threading.Event`. **NOTE the reference sets `self.daemon = True` (`poller.py:7`)
    — this is the EXACT E12-S4 daemon-thread-leak source; the de-brand must make the poll thread
    stoppable/joinable in tests (see the poll-thread-hygiene note), do NOT copy the bare daemon posture.**
  - **Definition cache** → `posthog-python/posthog/flag_definition_cache.py`
    (`FlagDefinitionCacheProvider` Protocol, `get_flag_definitions`, `should_fetch_flag_definitions`,
    `shutdown`).
  Do NOT invent the local-eval rule/hash shape — port from these files, de-branded.
- **The hash MUST match S1 and the backend bit-for-bit — assert the IDENTICAL pinned vector
  (— posthog-source-guide 2026-07-10):** this is the load-bearing parity invariant. S3's known-vector
  test asserts the SAME three-tier vector S1 pins (do not invent a different one — a different vector
  can't prove cross-tree identity):
  (1) `SHA1("some-flag.some_distinct_id") == "e4ce124e800a818c63099f95fa085dc2b620e173"`;
  (2) exact floats `("simple-flag","distinct_id_0") → 0.78369637642204315`,
  `("simple-flag","distinct_id_1") → 0.33970699269954008`,
  `("simple-flag","distinct_id_2") → 0.37204343502390519`,
  variant-salt `("multivariate-flag","distinct_id_0") → 0.61864545379303792`;
  (3) `simple-flag` at 45% over `distinct_id_{0..9}` →
  `[False,True,True,False,True,False,False,True,False,True]`.
  These are the SAME real reference-suite vectors S1 asserts (`posthog-python`'s own suite carries the
  identical `simple-flag`/45% + `multivariate-flag`/55% consistency vectors at
  `posthog/test/test_feature_flags.py:5640-6664` — a second confirmation the algorithm is shared). Any
  divergence means TS and Python disagree for the same actor. Port verbatim; strip only vendor naming.
  S4 anchors this same vector cross-tree — if S1 and S3 both assert it, S4 documents it as the parity
  anchor rather than re-deriving. Consult `architect` only if the exact backend hash shape is ever in
  doubt against a live ground-truth diff (S4).
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
- **Poll-thread hygiene — TWO leak vectors, both pinned (— E12-S4 lesson, mechanism-specific):** the
  E12-S4 defect was `create_server_analytics(cfg)`-based keyed-slot tests spinning daemon `BatchConsumer`
  threads without `sync_mode`/`shutdown`, which turned the suite red via the `..._leaks_no_thread`
  reliability assertion (deterministic: green WITHOUT the file, red WITH — NOT a pre-existing flake; the
  builder must not misread it as one). S3 adds a SECOND vector: the definition poll thread. The reference
  `Poller(threading.Thread)` sets `self.daemon = True` (`posthog-python/posthog/poller.py:7`) — do NOT
  copy that bare posture. Concretely, for the suite to stay leak-free:
  1. The poll thread MUST expose a `stop()` (a `threading.Event`-gated loop, mirror `poller.py`'s
     `stop()`/`stopped` — but joinable) and every test that starts it calls `stop()` in teardown (or use
     an injectable/synchronous clock so no real thread spins);
  2. Any test that reaches the poller via `create_server_analytics(cfg).flags` (the slot path) must ALSO
     pass `sync_mode=True` / call `shutdown()` so the ingest `BatchConsumer` doesn't leak — the exact
     E12-S4 fix, now compounded by the poll thread.
  Prove the suite is deterministic green with AND without this file (the E12-S4 orchestrator gate). The
  `test_flag_adapter.py` sibling from E12-S4 is the pattern to mirror for both.
- **E13's load-bearing invariant:** ZERO seam/port change. This is the regression check that E12's port
  shape holds across BOTH trees. A needed port/context change is an E12-was-wrong escalation.

> Reviewer suggestion (2026-07-10): The poller URL emits `&send_cohorts=` empty (`poller.py`). Confirm in S4's live diff that cohorts actually arrive on the wire — the local cohort map is what separates `InconclusiveMatchError` from `RequiresServerEvaluation`. (Same `send_cohorts` note as S1; S4 live-wiring.)
> Reviewer suggestion (2026-07-10): The evaluator deliberately drops the reference `early_exit` short-circuit (parity with S1/TS, "strictly more conservative") — resolved VALUES are identical, only whether a fallback round-trip fires can differ from a pure-reference eval. Documented, not a defect.

## Shipped

> Captured by `implement-epics` on 2026-07-10.

- **Files changed:** `python/src/analytics_kit/config.py`, `python/src/analytics_kit/server/__init__.py`, `python/src/analytics_kit/flags/{adapter.py,config.py,factory.py}`
- **Files added:** `python/src/analytics_kit/flags/local/` (evaluator + poller + matcher subdir), `python/tests/{test_flag_local_eval.py,test_flag_local_resolution.py}`
- **New public API:** none new on the neutral surface. The Python `FlagClientConfig`/`FlagsConfig` gained the local-eval knobs (`definitions_endpoint`, `definitions_key` (role-named), `poll_interval`, `only_evaluate_locally`, `strict_local_evaluation`), Pydantic-validated. The local evaluator + poll daemon are adapter-internal.
- **Tests added:** `test_flag_local_eval.py` + `test_flag_local_resolution.py` (78 local tests): the 3-tier hash vector asserted at S1's EXACT literals (byte-for-byte cross-tree), `match_property` operators, both inconclusive signals, local-first resolves with ZERO round-trip (post-count asserted), inconclusive → ONE narrowed `_round_trip`, `only_evaluate_locally` suppression, local-vs-remote indistinguishable, poll-daemon stop (no leaked thread), factory local-only edge.
- **Commit:** `main` (message = story title)
- **Reviewer notes:** ship-ready, no critical, first review. Reviewer **independently recomputed the hash in a standalone python process** — all 3 tiers float64-identical to S1 (arithmetic verified vs `feature_flags.py:79-82,:14` — 15-f `float` divisor, not Decimal/int-div). Verified sync/no-asyncio (`evaluate` non-coroutine, `ports.py` byte-unchanged), the poll-daemon stop mechanism in CODE (`stop()` sets an Event + joins; `while not stopped.wait(interval)`; ran the suite 3× with ZERO surviving `analytics-kit-flag-poller` threads — the E12-S4 leak genuinely avoided), the S2-mirrored branch, zero-seam-change, factory edge, neutrality (`--full` 0, `_WIRE_*` confined, `definitions_key` role-named). 2 S4-forward suggestions captured.
- **Cross-story seams exposed:** feature-flags LOCAL eval now reaches parity across both server trees (TS node S1/S2 + Python S3), all behind the UNCHANGED `evaluate` (E12 port frozen). **S4 (ground-truth + parity proof)** — diffs THIS Python local path (+ the TS node path) against a real remote eval; asserts the cross-tree hash IDENTITY (both trees assert S1's exact vector — S4 names it the single anchor); negative control: a fully-local-decidable set issues ZERO remote calls (post-count 0). Live diff gated on the privileged definition-reading key; the loopback/mock + hash-vector layers are the CC-reachable green path. Confirm `send_cohorts` on the wire; the `early_exit` deferral is documented (conservative, identical values).
