---
id: PY3-CORE-taxonomy-allowlist
status: active
area: core
touches: [privacy]
api_impact: additive
blocked_by: [PY2-CORE-python-seam]
updated: 2026-07-10
---

# PY3-CORE-taxonomy-allowlist — Typed taxonomy + payload allowlist (Python)

## Why

The typed taxonomy and the payload allowlist are the library's **OWN** surface — they have **zero analogue in posthog-python** — and they are exactly what the Python port must preserve to stay at parity with the TS lib's headline capability. This is the Python realization of TS `E3-CORE-taxonomy-allowlist`, ported *to* `ts/packages/analytics-kit/src/{taxonomy,allowlist}.ts`. Everything downstream (PY4 capture, PY5 query) gates through the allowlist and types off the taxonomy. Informed by the architect consult (2026-07-09), Cluster 2.

## Success criteria

- The **payload allowlist ports 1:1**: a pure function that inspects `dict.keys()` against a consumer-supplied `frozenset`, with the same `throw` / `drop-and-error-log` `ViolationPolicy`, gated at the client call-boundary **pre-enrichment**, holding identically for every adapter (bar A: one privacy code path). `derive_allowlist_from_taxonomy` ports cleanly.
- The **typed taxonomy is a two-layer mechanism**: (1) a full-fidelity **runtime registry** (`define_taxonomy(...)` returns an object driving `derive_allowlist` + runtime prop validation), plus (2) a **best-effort static layer** (`TypedDict` per event + a `Literal[...]` union of event names + a generic keyed surface). mypy enforces the event-NAME set and per-event prop keys/types **only where the consumer declares them**; the runtime registry catches the rest at call time honoring `ViolationPolicy`.
- **The guarantee gap is stated, not hidden**: Python promises **runtime-registry parity + best-effort static typing**, NOT TS-parity on compile-time safety (Python has no const generics; `define_taxonomy<const T>()`'s inferred mapped-type safety does not survive). Docs and the parity matrix (PY8) must say so.
- **Privacy POLICY is the consumer's; ENFORCEMENT is the library's** — the allowlist ships zero event/property names. The taxonomy is typing; it is **NEVER auto-derived into the allowlist without the consumer opting in** (`derive_allowlist_from_taxonomy` is a consumer-invoked convenience, not an implicit default).
- Keys the library **computes** are trusted; keys/values the consumer **supplies** are gated (the E3 rule, carried cross-language). Config-time `super_properties` (consumer-supplied) cross the gate too.

## Stories

Chain — `S1 → S2 → S3`; topo-sortable via `depends_on`. Written to `stories/2-ready-for-dev/`. **Re-sliced from the tentative shape:** `derive_allowlist_from_taxonomy` moved from S1 to S2 because it needs the taxonomy-registry SHAPE — so S1 is the `enforce_allowlist` half (no taxonomy dep), S2 adds the registry + derive, matching the TS reality (E3-S2 guard → E3-S3 derivation). Fills the PY1-skeleton `allowlist.py` + `taxonomy.py`.

- **[PY3-S1](../stories/2-ready-for-dev/PY3-S1-allowlist-guard-and-wiring.md)** *(additive, no deps)* — `enforce_allowlist(allowlist, on_violation, *bags) -> bool` (keys-only, variadic, both policy branches, `is not None` activation) ported 1:1 from TS + `ViolationPolicy` + wiring into the PY2 provider call-boundary (gate `properties`+merged `super_properties` on capture, `traits` on set/set-group; routing ids not gated) + `AnalyticsConfig.allowlist`/`on_violation`.
- **[PY3-S2](../stories/2-ready-for-dev/PY3-S2-taxonomy-registry-and-derive.md)** *(additive, depends on S1)* — `define_taxonomy(decl)` runtime registry (`.decl` + `PropType`→python validator) + `derive_allowlist_from_taxonomy` (consumer-invoked, keys-only, no name leak); **reserves NOTHING** (architect: no reserved event-name set, no `__ak_` prefix server-side); **no auto-derivation from `config.taxonomy`** (the R1 lesson).
- **[PY3-S3](../stories/2-ready-for-dev/PY3-S3-best-effort-static-typing.md)** *(additive, depends on S2)* — best-effort static layer (`TypedDict`-per-event + `Literal` event-name union + generic keyed surface; NO overloads, NO mypy plugin) + mypy honesty tests proving what IS and ISN'T caught + the stated guarantee (runtime-registry parity + best-effort static, NOT TS compile-time parity).

Build topo order: `PY3-S1 → PY3-S2 → PY3-S3`. Submodules: `allowlist.py` (S1), `taxonomy.py` (S2+S3), plus the `AnalyticsConfig` extension threaded through the factory.

## Out of scope

- Any hand-written per-event `@overload` explosion — RULED OUT (see Notes); the static layer is `TypedDict`/`Literal` + a generic surface, not overloads.
- A mypy plugin that reads `define_taxonomy` and synthesizes types — RULED OUT (maintenance sink; can't do const-generic inference anyway).
- Auto-deriving the allowlist from the taxonomy by default — the taxonomy is typing; the allowlist is a consumer privacy decision.
- Server capture / query wiring (PY4/PY5) — they *consume* this epic's gate + types.

## Notes

- **Library's OWN surface — zero posthog analogue.** — architect (2026-07-09, Cluster 1): posthog-python's `capture(event: str, **kwargs)` has NO taxonomy typing (`event` is a bare `str`, props are `Dict[str, Any]`). The Python port must do BETTER than posthog-python here because the taxonomy is capability-defining. This is ported from the TS seam, not de-branded from posthog-python.
- **Two-layer taxonomy; the guarantee is weaker than TS — state it.** — architect (2026-07-09, Cluster 2, high on mechanism + on the honesty): runtime registry = full fidelity; static layer = best-effort. TS's `defineTaxonomy<const T>()` + `PropsOf`/`ShapeOf` mapped-type *inference* from a single value declaration **does not translate** (no const generics). mypy enforces name-set + prop shape only where the consumer hand-declares `TypedDict`/`Literal`; the name↔props linkage falls to the runtime registry.
- **PM-locked (2026-07-09): promise = runtime-registry parity + best-effort static typing; NOT hand-written per-event overloads.** Resolves the architect's surviving open question #2. Overloads don't scale past ~dozens of events and are an authoring sink; a mypy plugin is too heavy for R-parity. The `TypedDict`/`Literal` + generic-surface middle is the scalable call. The port's promise to consumers is runtime enforcement + best-effort static help — the epic and the PY8 parity matrix must say this explicitly rather than imply TS-parity.
- **Allowlist is NOT Pydantic.** — architect (2026-07-09, Cluster 2): it's a bespoke key-membership check with a violation policy (the `enforce_allowlist` port), a plain function exactly as TS `allowlist.ts` — not schema validation.
- **Reserved-internal-key discipline carries cross-language.** The TS `__ak_` reserved prefix + `internalKind` structural discriminant + reserved event names (`page`/`pageleave`) are seam semantics, not TS accidents — the Python taxonomy must reserve the internal-event names so a consumer can't redeclare them, and internal keys use a reserved prefix, mirroring the R1 hardening lesson (HISTORY.md).

## Expansion path

A future feature-flag capability declares its own taxonomy-typed surface + allowlist-gated payloads through the same two-layer mechanism — additive, no change to the allowlist function or the registry shape.
