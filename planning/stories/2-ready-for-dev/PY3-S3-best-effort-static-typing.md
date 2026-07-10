---
id: PY3-S3-best-effort-static-typing
epic: PY3-CORE-taxonomy-allowlist
status: ready-for-dev
area: core
touches: []
depends_on: [PY3-S2-taxonomy-registry-and-derive]
api_impact: additive
---

# PY3-S3-best-effort-static-typing — Best-effort static typing layer + the honest guarantee

## Why

The runtime registry (PY3-S2) is full-fidelity, but the library's headline capability is *typed* taxonomy — so the port must offer the best static safety Python can give, while being honest that it is weaker than TS. This story lands the best-effort static layer (`TypedDict`-per-event + a `Literal` event-name union + a generic keyed client surface) and the mypy tests that PROVE what is and isn't caught statically — the honest guarantee, stated not hidden.

## Scope

### In

- The best-effort static typing layer over `define_taxonomy` (in `analytics_kit/taxonomy.py` + the provider verb signatures):
  - A `Literal[...]` union of the declared event NAMES (so `capture("undeclared", ...)` is a mypy error where the consumer declares their event-name literal).
  - A `TypedDict`-per-event convenience so a consumer who declares a `TypedDict` for an event's props gets mypy checking of prop keys/types at the call site.
  - A **generic keyed client surface** — the provider/`capture` typed via generics (`Unpack`/`TypedDict` where it buys checking) so a consumer's declared shapes flow through. Where the linkage between event name and its prop shape cannot be statically inferred (Python has no const-generic value→type inference), it falls to the PY3-S2 runtime registry.
- mypy tests (a `tests/` module) that assert, via `assert_type` / `reveal_type` / `# type: ignore[...]` expectations, BOTH:
  - what IS caught statically (declared event name set; declared prop keys/types where the consumer supplies a `TypedDict`), and
  - what is NOT caught statically (the name↔props linkage that has no const-generic analog) — encoded as a test so the guarantee is documented, not implied.
- A short docstring / module note stating the guarantee explicitly: **runtime-registry parity + best-effort static typing; NOT TS compile-time parity.**

### Out

- Any hand-written per-event `@overload` explosion — **RULED OUT** (Technical notes): does not scale past ~dozens of events, an authoring sink.
- A **mypy plugin** that reads `define_taxonomy` and synthesizes types — **RULED OUT** (maintenance sink; can't do const-generic inference anyway).
- The runtime registry / derive / validator — **PY3-S2** (this story is the static layer over it).
- The PY8 parity-matrix row that records the guarantee gap — PY8 (this story states it locally; PY8 audits it project-wide).

## Acceptance criteria

- [ ] A consumer who declares their event-name `Literal` / per-event `TypedDict`s gets mypy errors on: an undeclared event name; a wrong prop type; a missing required prop — proven by mypy test expectations.
- [ ] A no-taxonomy consumer still type-checks (the generic surface defaults loose — the bar-B path: adding a taxonomy is config-only, zero library change).
- [ ] The static layer uses `TypedDict` + `Literal` + a generic surface — there are **no** hand-written per-event `@overload`s and **no** mypy plugin.
- [ ] A mypy test encodes what is NOT statically caught (the name↔props linkage), so the honest guarantee is documented as a test, not just prose.
- [ ] A module note states: runtime-registry parity + best-effort static typing, NOT TS compile-time parity.
- [ ] `uv run mypy` (strict) exit 0 on the library AND the mypy-expectation tests pass (the negative expectations are genuinely consumed — a `# type: ignore` that stops being needed should surface via `warn_unused_ignores`).
- [ ] `uv run ruff check`, `uv run pytest` exit 0.
- [ ] Zero vendor token in the static layer / docstrings; `grep -ri posthog analytics_kit/taxonomy.py` clean.

## Technical notes

- **Two-layer taxonomy; the guarantee is weaker than TS — STATE it.** — architect (2026-07-09, Cluster 2, high on mechanism + on the honesty) + PM-lock (2026-07-09): runtime registry (PY3-S2) = full fidelity; this static layer = best-effort. TS's `defineTaxonomy<const T>()` + `PropsOf`/`ShapeOf` mapped-type INFERENCE from a single value declaration **does not translate** (no const generics, weaker mapped types). mypy enforces the name-set + prop shape only where the consumer hand-declares `TypedDict`/`Literal`; the name↔props linkage falls to the PY3-S2 runtime registry.
- **The promise (PM-locked 2026-07-09): runtime-registry parity + best-effort static typing — NOT hand-written overloads, NOT a mypy plugin.** Overloads don't scale past ~dozens of events and are an authoring sink; a mypy plugin is too heavy for R-parity and still can't do const-generic inference. The `TypedDict`/`Literal` + generic-surface middle is the scalable call. The epic + the PY8 parity matrix must say this explicitly rather than imply TS-parity — this story states it locally.
- **`Unpack[TypedDict]` for kwargs** is the closest Python analog to TS's per-event typed props (the mechanism posthog-python itself reaches for, though posthog-python does it untyped `Dict[str, Any]` — the port must do better). Use it where it buys checking; accept that the name→shape selection is not statically inferable and document that boundary.
- **CONTRACT reference:** `ts/packages/analytics-kit/src/taxonomy.ts` (the `ShapeOf`/`PropsOf`/`PropsParam` mapped-type machinery — the thing that CANNOT be fully ported, and whose absence is the guarantee gap) + `taxonomy.test.ts` (the compile-time `@ts-expect-error` pins whose Python analogs are this story's mypy expectations). posthog-python is not a reference (no taxonomy).
- **mypy honesty tests** are the Python analog of the TS `@ts-expect-error` type-pins: use `typing.assert_type` for the positives and `# type: ignore[...]` (with `warn_unused_ignores` on, so a stale ignore fails) for the negatives, so both what-is-caught and what-isn't are executable expectations.
- **Neutrality lesson — docstrings ship** vendor-neutral; only `#`-comments carry provenance.

## Shipped

<!-- Captured by implement-epics on close. -->
