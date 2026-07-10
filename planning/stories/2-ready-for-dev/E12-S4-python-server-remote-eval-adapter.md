---
id: E12-S4-python-server-remote-eval-adapter
epic: E12-FF-flag-substrate-remote-eval
status: ready-for-dev
area: feature-flags
touches: [node]
depends_on: [E12-S1]
api_impact: additive
---

# E12-S4-python-server-remote-eval-adapter — Python server remote-eval flag adapter

## Why

Parity: the Python server tree must reach every capability the TS surface exposes. This is the Python analog of S3 — a server-shaped remote-eval flag adapter satisfying the SAME neutral `FeatureFlagPort` (pinned in S1's `ports.py`), de-branded from `posthog-python`. Feature-flags is a genuine both-trees capability; the server half is the richer one, so Python advances alongside node here, not as an N/A.

## Scope

### In

- **Python flag adapter (`python/src/analytics_kit/` — a server-side module, named by role)** — a class satisfying the S1 `FeatureFlagPort` Protocol:
  - `evaluate(context=None)` → a remote round-trip returning the `FlagSet`, de-branded from `posthog-python`'s server flag-eval path.
  - **`distinct_id` required + validated** — raises a clear neutral error when absent (parity with S3's node behavior; no ambient server actor).
  - `on_change(listener)` fires **once** with the resolved snapshot (the stateless-server degenerate case); returns an unsubscribe callable.
  - `FlagSet` sync reads (`is_enabled`/`get_flag`/`get_payload`/`get_all`) + the neutral degradation signal (`degraded`/`reason`) mapped from round-trip success/failure; vendor eval-quality fields stay adapter-internal.
  - Accept `config.flags.bootstrap` as a resolved-set seed/fallback where meaningful (SSR request-scoped), parity with S3 — server path is remote-primary.
- **Factory wiring (`python/src/analytics_kit/factory.py` or provider selection)** — attach the flag adapter to the provider `flags` slot when keyed; unkeyed leaves it `None`. Config-only (bar B).
- **Tests (`python/tests/`)** — against a mock round-trip (never a real backend): `distinct_id`-required raises; `evaluate` resolves the snapshot; `on_change` fires exactly once; `degraded`/`reason` on failure; runtime-registry `flags`-slot reads work; the best-effort-static typing recipe (PY3 pattern) covers a typed flag view where hand-declared.

### Out

- **Local (in-process) eval** — the Python-central server-shaped specialization (definition polling + rule matching) is **E13**, behind this unchanged `evaluate`. Only the remote path here.
- **Browser / node adapters** — S2 / S3.
- **DOM / browser concerns** — Python is server-shaped; there is no browser flag adapter analog (the inverse of session-replay's browser-only asymmetry).
- **`$feature_flag_called` auto-capture** — out of the epic; `evaluate`/reads trigger no capture.
- **A recursive JSON-schema payload type** — flat-`PropDecl` ceiling (nested ⇒ `unknown`), parity with TS.

## Acceptance criteria

- [ ] The Python flag adapter satisfies the S1 `FeatureFlagPort` Protocol method-for-method (`evaluate`/`on_change`/`FlagSet` reads/`degraded`/`reason`) — bar A: one neutral port, Python + TS-node targets, zero consumer change.
- [ ] `evaluate` with no `distinct_id` raises a clear neutral error (no vendor token in the message); with `distinct_id` it returns the resolved `FlagSet` via the mocked round-trip.
- [ ] `on_change` fires exactly once with the resolved set (a test asserts once-cardinality); the returned unsubscribe is sound.
- [ ] A failed round-trip sets `FlagSet.degraded = True` + a neutral `reason`; no vendor eval-quality field leaks onto the snapshot.
- [ ] The runtime `flags`-slot registry reads work; the best-effort-static recipe covers a hand-declared typed flag view (PY3 ceiling — runtime-registry parity, not TS compile-time literal parity).
- [ ] Neutrality: `grep -ri posthog python/src/analytics_kit` clean (save the architect-locked provenance-comment exemption); wire tokens confined to `_WIRE_*`; the Python neutrality-scan analog green.
- [ ] Gates green: `cd python && uv run pytest && uv run ruff check && uv run mypy`; tests mock the round-trip, never a live backend.

## Technical notes

- reference: `posthog-python` (the server-SDK analog — the flag-eval remote path). **Development prerequisite:** `posthog-python` must be cloned beside `posthog-js/` at the repo root before this story (per CLAUDE.md — clone it when the Python flag work starts). De-brand: strip `posthog`/`$feature*` from every neutral-facing name; endpoint + request/response confined to `_WIRE_*` internals. Consult `posthog-source-guide` for how `posthog-python` shapes the flag-eval request/response before porting.
- **Parity is by shared contract, not shared code (— CLAUDE.md):** this adapter satisfies the SAME `FeatureFlagPort` S1 pinned — it does NOT import from `ts/`, and `ts/` does not import from here. The port pinned in `python/src/analytics_kit/ports.py` (S1) is the contract; this story implements against it, server-shaped.
- **`distinct_id` required (— architect 2026-07-10):** validated by the adapter, parity with S3. Neutral error message, no vendor token. Do NOT invent a fake ambient actor.
- **`on_change` once-cardinality (— architect 2026-07-10):** stateless server — fires once with the resolved snapshot, then never. Parity with S3.
- **Best-effort-static ceiling (PY3):** the `flags` taxonomy slot participates in the runtime registry (full fidelity) + the hand-declared typed-view recipe (best-effort static) — NOT the TS const-generic compile-time guarantee. Mirror exactly how PY3 handled `events`/`traits` typing; do not attempt more.
- **E13 regression check:** local eval (Python-central) slots behind this unchanged `evaluate` with zero seam change. Keep the remote path a cleanly separable strategy inside the adapter.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/. Do not hand-edit. -->
