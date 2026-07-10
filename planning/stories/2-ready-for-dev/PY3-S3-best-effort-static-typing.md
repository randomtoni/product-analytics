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

The runtime registry (PY3-S2) is full-fidelity, but the library's headline capability is *typed* taxonomy — so the port must offer the best static safety Python can give, while being honest that it is weaker than TS. This story lands the best-effort static layer (a consumer-authored `Protocol` typed-view — per-event `@overload`s over `TypedDict`s + a `Literal` event-name union — applied via `cast`) and the mypy tests that PROVE what is and isn't caught statically — the honest guarantee, stated not hidden.

## Scope

### In

- The best-effort static typing layer over `define_taxonomy`. **Mechanism (architect-verified 2026-07-10 against mypy 1.19 `--strict --warn-unused-ignores`, matching `pyproject.toml`): a consumer-authored `Protocol` typed-VIEW reached by `cast`. NOT a generic provider, NOT provider subclassing, NOT `Unpack[TypedDict]` — all three fail strict mypy or break PY2 verb parity (see Technical notes for the killed paths).** Concretely:
  - The runtime provider surface (`capture`, `set`, `set_group_traits` in `provider.py`) is **UNCHANGED from PY2** — the typed view is a static reinterpretation via `cast`, a runtime no-op. This satisfies bar-B (adding a taxonomy is config-only, zero runtime-signature change) and keeps every PY2 provider test green.
  - The consumer authors a `Protocol` with one `@overload` of `capture` per declared event — each overload pins `event: Literal["<name>"]` and `properties: <TheirTypedDict>`. They obtain the typed view with `cast(TheirTypedAnalytics, create_analytics(config, adapter))`. Because it is a `cast`, not a subclass, there is NO LSP/`[override]` conflict (subclassing the runtime provider to narrow `event: str → Literal` fails strict mypy unfixably — proven).
  - The `Literal` event-name union and per-event `TypedDict`s are **consumer-authored** — the library CANNOT generate them from `define_taxonomy` (the const-generic wall: `TypeVar(bound=TypedDict)` is a mypy error; a generic `Protocol[E,P]` binds only ONE event per parametrization). The runtime `.decl` (PY3-S2) is the source of truth the consumer mirrors by hand; that hand-mirroring IS the honestly-stated static gap.
  - The library ships (static-only, in `analytics_kit/taxonomy.py`): the documented typed-view `Protocol`+`cast` pattern (as a docstring recipe) + re-exports/convenience so the consumer imports `TypedDict`/`Literal`/`overload`/`Protocol`/`cast` from one place. OPTIONALLY a single-event generic `Protocol[E, P]` (TypeVars `contravariant=True` — mypy requires it) as a boilerplate convenience, explicitly NOT the mechanism (it can't express the full name→shape map).
- mypy honesty tests (a `tests/` module mypy sees — `files=["src","tests"]`) asserting BOTH, via `typing.assert_type` positives and `# type: ignore[<code>]` negatives (under `warn_unused_ignores`, a stale ignore fails the run):
  - what IS caught: on the cast typed-view, a bad event name / a wrong prop type / a missing required prop each error. **Author the honesty Protocol with ≥2 overloads** so every negative carries the uniform `# type: ignore[call-overload]` (proven clean). A 1-overload Protocol SPLITS the codes — bad name `[arg-type]`, wrong/missing prop `[typeddict-item]`, plus a `[misc] Single overload definition` warning — so ≥2 overloads is the pinned shape. Match the exact code per assertion or `warn_unused_ignores` fails.
  - what is NOT caught (the name↔props linkage / no auto-linkage): call the RAW runtime `Analytics` (NOT the cast view) with a wrong-typed prop — mypy reports NOTHING (the runtime sig is `dict[str, object]`). That silent raw call, sitting beside the erroring typed-view call, is the executable proof that static checking exists ONLY where the consumer hand-declares — never library-inferred.
- A short docstring / module note stating the guarantee explicitly: **runtime-registry parity + best-effort static typing; NOT TS compile-time parity.**

### Out

- Any LIBRARY-shipped per-event `@overload` explosion — **RULED OUT** (Technical notes): the library cannot generate overloads from `define_taxonomy` (const-generic wall), and hand-authoring them in the library does not scale. The CONSUMER authors overloads in their own typed-view `Protocol` (that is the mechanism); the library does not.
- **Provider subclassing to carry the typed surface** — **RULED OUT** (architect-proven): a subclass overloading `capture` to narrow `event: str → Literal[...]` fails strict mypy with `[override]` (LSP violation), unfixably. The typed view is a `cast`, never inheritance.
- **`Unpack[TypedDict]` kwargs on `capture`** — **RULED OUT**: forces `capture("e", **{...})`, breaking the single-positional-`properties` signature and PY2 verb parity.
- A **mypy plugin** that reads `define_taxonomy` and synthesizes types — **RULED OUT** (maintenance sink; can't do const-generic inference anyway).
- The runtime registry / derive / validator — **PY3-S2** (this story is the static layer over it).
- The PY8 parity-matrix row that records the guarantee gap — PY8 (this story states it locally; PY8 audits it project-wide).

## Acceptance criteria

- [ ] A consumer who declares a typed-view `Protocol` (≥2 `@overload`s of `capture`, each `event: Literal[...]` + a per-event `TypedDict`) and applies it via `cast` gets mypy errors on: an undeclared event name; a wrong prop type; a missing required prop — proven by mypy test expectations, each negative carrying `# type: ignore[call-overload]`.
- [ ] The runtime provider signature (`capture`/`set`/`set_group_traits`) is UNCHANGED from PY2 — the typed view is a `cast`-only reinterpretation. Every existing PY2 provider test stays green; a no-taxonomy / no-cast consumer still type-checks against the loose runtime surface (bar-B: adding a taxonomy is config-only, zero runtime-signature change).
- [ ] The static layer is the consumer-authored `Protocol`+`cast` typed-view pattern — there are **no** library-shipped per-event `@overload`s (the consumer authors their own), **no** provider subclassing (LSP/`[override]` failure), **no** `Unpack[TypedDict]` kwargs surface (breaks PY2 verb parity), and **no** mypy plugin. The library ships only the documented pattern + typing re-exports (and optionally a single-event generic `Protocol`, not the mechanism).
- [ ] A mypy test encodes what is NOT statically caught: a wrong-typed prop call against the RAW runtime `Analytics` (not the cast view) produces NO mypy error — proving checking exists only where the consumer hand-declares. This silent call sits beside an erroring typed-view call so the guarantee is a test, not just prose.
- [ ] A module note states: runtime-registry parity + best-effort static typing, NOT TS compile-time parity.
- [ ] `uv run mypy` (strict) exit 0 on the library AND the mypy-expectation tests pass (the negative expectations are genuinely consumed — a `# type: ignore` that stops being needed should surface via `warn_unused_ignores`).
- [ ] `uv run ruff check`, `uv run pytest` exit 0.
- [ ] Zero vendor token in the static layer / docstrings; `grep -ri posthog analytics_kit/taxonomy.py` clean.

## Technical notes

- **Two-layer taxonomy; the guarantee is weaker than TS — STATE it.** — architect (2026-07-09, Cluster 2, high on mechanism + on the honesty) + PM-lock (2026-07-09): runtime registry (PY3-S2) = full fidelity; this static layer = best-effort. TS's `defineTaxonomy<const T>()` + `PropsOf`/`ShapeOf` mapped-type INFERENCE from a single value declaration **does not translate** (no const generics, weaker mapped types). mypy enforces the name-set + prop shape only where the consumer hand-declares `TypedDict`/`Literal`; the name↔props linkage falls to the PY3-S2 runtime registry.
- **The promise (PM-locked 2026-07-09): runtime-registry parity + best-effort static typing — NOT LIBRARY-shipped hand-written overloads, NOT a mypy plugin.** A library that hand-authors overloads for consumer events doesn't scale and can't be generated (const-generic wall); a mypy plugin is too heavy for R-parity and still can't do const-generic inference. The scalable call is the consumer-authored `Protocol`+`cast` typed-view (the consumer's own overloads, mirrored by hand from the runtime `.decl`). The epic + the PY8 parity matrix must say this explicitly rather than imply TS-parity — this story states it locally.
- **Mechanism = consumer-authored `Protocol` typed-view via `cast` (architect-verified 2026-07-10, mypy 1.19 `--strict --warn-unused-ignores`).** The killed paths, each empirically failed so the builder rules them out with confidence:
  - **Provider subclass with overloaded `capture`** → strict mypy `Signature of "capture" incompatible with supertype [override]`, always, unfixably (narrowing `event: str → Literal` violates LSP). The typed surface CANNOT inherit from the runtime provider.
  - **`Unpack[TypedDict]` kwargs** → forces `capture("e", **{...})`, breaks the single-positional-`properties` PY2 signature/verb parity.
  - **Library-shipped generic `Protocol` over the whole event MAP** → `TypeVar(bound=TypedDict)` is a mypy error; a generic `Protocol[E, P]` binds only ONE event per parametrization. This is the const-generic wall the PM/architect already locked, now confirmed at the toolchain level. A single-event generic `Protocol[E, P]` (contravariant TypeVars) works only as an optional boilerplate convenience, not the mechanism.
  - The working shape: consumer authors a `Protocol` with `@overload` per event, applies it via `cast(TypedView, create_analytics(...))`. `cast` is a runtime no-op → runtime signature untouched, no LSP conflict. Proven: exactly the three intended errors (bad name / wrong type / missing required prop), zero spurious `[override]` noise.
- **Exact `# type: ignore` codes (pin them or the run fails under `warn_unused_ignores`):** with **≥2 overloads** in the typed-view Protocol (the shape to author), every negative is uniformly `# type: ignore[call-overload]` — clean run confirmed. A **1-overload** Protocol SPLITS the codes (bad name `[arg-type]`, wrong/missing prop `[typeddict-item]`) and emits a `[misc] Single overload definition` warning — so author with ≥2 overloads. The positives use `typing.assert_type`.
- **CONTRACT reference:** `ts/packages/analytics-kit/src/taxonomy.ts` (the `ShapeOf`/`PropsOf`/`PropsParam` mapped-type machinery — the thing that CANNOT be fully ported, and whose absence is the guarantee gap) + `taxonomy.test.ts` (the compile-time `@ts-expect-error` pins whose Python analogs are this story's mypy expectations). posthog-python is not a reference (no taxonomy).
- **mypy honesty tests** are the Python analog of the TS `@ts-expect-error` type-pins: use `typing.assert_type` for the positives and `# type: ignore[...]` (with `warn_unused_ignores` on, so a stale ignore fails) for the negatives, so both what-is-caught and what-isn't are executable expectations.
- **Neutrality lesson — docstrings ship** vendor-neutral; only `#`-comments carry provenance.

## Shipped

<!-- Captured by implement-epics on close. -->
