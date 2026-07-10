---
id: E12-S4-python-server-remote-eval-adapter
epic: E12-FF-flag-substrate-remote-eval
status: ready-for-dev
area: feature-flags
touches: [python]
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
- **Factory wiring** — attach the flag adapter to the Python provider's `flags` slot when keyed; unkeyed leaves it `None`. Config-only (bar B). **Python DOES have a provider `flags` slot (unlike TS-node):** the server provider class is `Analytics` (`python/src/analytics_kit/provider.py:73`), which carries `flags: FeatureFlagPort | None = None` (class annotation `provider.py:76` + `self.flags = None` init `provider.py:94`) — retyped in S1. So the Python attach is via `analytics.flags` (the provider slot), NOT a standalone factory. This is a legitimate per-tree difference from S3: TS split its server capture into a separate 5-member `NodeAnalytics` interface (no `flags` slot) so TS-node uses a standalone `createFlagClient` factory; Python's single `Analytics` provider keeps the `flags` slot, so Python attaches there. Both satisfy the SAME neutral `FeatureFlagPort` — bar A holds regardless of retrieval shape. Wire the attach through `create_analytics` (`factory.py:21`) — construct the flag adapter from `config.key`/endpoint and set it on the returned `Analytics` instance when keyed; unkeyed leaves the `None`-default from `factory.py`'s `NoopAdapter` path. (If a two-piece target-module selection reads `config.key` like the query/server adapters do, keep the flag adapter's `config.key` read in the target module, per `factory.py`'s docstring "a target adapter that reads `config.key` is never imported here".)
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

- **BLOCKING PRECONDITION — clone `posthog-python` first (builder: do this before writing any code).** This is a DE-BRAND REFERENCE prerequisite, distinct from a ground-truth-key prerequisite: the epic's "no development prerequisite for E12 remote eval" (dependency-graph note) means the BARS are mock-provable without a live backend key — it does NOT waive the reference checkout. This adapter de-brands from `posthog-python`, which is NOT yet cloned (only `posthog-js/` is at the repo root today). Per CLAUDE.md, `posthog-python` (PostHog/posthog-python) must be cloned beside `posthog-js/` at the repo root before this story. If it is absent when the builder starts, that is a hard stop — clone it (or route to the user) before porting; do NOT invent the flag-eval request/response shape without the reference. `posthog-source-guide` currently reads the `posthog-js/` checkout only, so it can inform the neutral SHAPE but cannot confirm `posthog-python`'s exact request/response until the clone lands.
- reference: `posthog-python` (the server-SDK analog — the flag-eval remote path). De-brand: strip `posthog`/`$feature*` from every neutral-facing name; endpoint + request/response confined to `_WIRE_*` internals. Consult `posthog-source-guide` for the neutral flag-eval shape (grounded in `posthog-js/` node until the `posthog-python` clone lands) before porting.
- **`evaluate` is SYNCHRONOUS in Python (parity clarification, — matches S1's locked Python-sync decision):** the Python `FeatureFlagPort.evaluate` is a plain `def evaluate(context=None) -> FlagSet` returning a BARE `FlagSet` — NOT `async def`, NOT a coroutine. "Parity with S3" means the same METHOD SURFACE and behavior (once-fire `on_change`, `distinct_id`-required, `degraded`/`reason`), NOT the same async-ness: TS's `evaluate` returns `Promise<FlagSet>` because the JS boundary is async; Python's is sync-by-posture (the locked no-asyncio server posture, `provider.py:40-49`), with the blocking round-trip inside the adapter — exactly how PY5's query surface hides its POST/poll behind a blocking `time.sleep` (`query/client.py:146`, `query/http_adapter.py`). The tests must state `evaluate` is sync-by-design so a future reader does not "fix" it toward asyncio.
- **Parity is by shared contract, not shared code (— CLAUDE.md):** this adapter satisfies the SAME `FeatureFlagPort` S1 pinned — it does NOT import from `ts/`, and `ts/` does not import from here. The port pinned in `python/src/analytics_kit/ports.py` (S1) is the contract; this story implements against it, server-shaped.
- **`distinct_id` required (— architect 2026-07-10):** validated by the adapter, parity with S3. Neutral error message, no vendor token. Do NOT invent a fake ambient actor.
- **`on_change` once-cardinality (— architect 2026-07-10):** stateless server — fires once with the resolved snapshot, then never. Parity with S3.
- **Best-effort-static ceiling (PY3):** the `flags` taxonomy slot participates in the runtime registry (full fidelity) + the hand-declared typed-view recipe (best-effort static) — NOT the TS const-generic compile-time guarantee. Mirror exactly how PY3 handled `events`/`traits` typing; do not attempt more.
- **E13 regression check:** local eval (Python-central) slots behind this unchanged `evaluate` with zero seam change. Keep the remote path a cleanly separable strategy inside the adapter.

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/. Do not hand-edit. -->
