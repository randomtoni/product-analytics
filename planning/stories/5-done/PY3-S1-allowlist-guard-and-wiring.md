---
id: PY3-S1-allowlist-guard-and-wiring
epic: PY3-CORE-taxonomy-allowlist
status: ready-for-dev
area: core
touches: [privacy]
depends_on: []
api_impact: additive
---

# PY3-S1-allowlist-guard-and-wiring — `enforce_allowlist` port + wiring into the provider call-boundary

## Why

The payload allowlist is the library's vendor-neutral privacy contract: only consumer-supplied keys leave the app, and a violation fails loudly. It ports 1:1 from `ts/packages/analytics-kit/src/allowlist.ts` (a pure keys-only function) and wires into the PY2 provider's call-boundary seam — before any minting or adapter sees the event — so the contract holds identically for every adapter (bar A). This story is the `enforce_allowlist` half only; `derive_allowlist_from_taxonomy` needs the taxonomy registry and lands in PY3-S2.

## Scope

### In

- `analytics_kit/allowlist.py`:
  - `ViolationPolicy = Literal["throw", "drop-and-error-log"]` (the locked union; a shared alias so config + provider can't drift).
  - `enforce_allowlist(allowlist, on_violation, *bags) -> bool` — a **pure keys-only** function (NOT Pydantic): `allowlist: frozenset[str] | None`, `on_violation: ViolationPolicy`, `*bags: dict[str, object] | None` (variadic). Semantics ported verbatim from the TS `enforceAllowlist` (see the pinned semantics table in Technical notes): `None` allowlist ⇒ inactive (all keys pass, return `True`); for each non-`None` bag, each key not in the allowlist is a violation; `throw` raises with the exact message naming the key; `drop-and-error-log` emits one error to the log sink and returns `False` (the drop signal) short-circuiting on the FIRST off-list key; a `None` bag is skipped; all-on-list ⇒ `True`.
  - The error/log message format ported exactly: `analytics-kit: property "<key>" is not on the payload allowlist`.
  - The log sink for `drop-and-error-log` — a small internal helper writing to `logging` (the Python analog of the TS `console.error` sink; see Technical notes).
- Extend `AnalyticsConfig` (PY2-S3 Pydantic model, `config.py`) additively: `allowlist: list[str] | None = None` and `on_violation: ViolationPolicy = "throw"`. Because PY2-S3 sets `extra="forbid"`, these become known fields (import `ViolationPolicy` from `allowlist.py` for the field type; keep `config.py` free of a runtime import cycle — `allowlist.py` must not import `config.py`).
- Extend the provider constructor to receive the resolved allowlist + policy. `Analytics.__init__` today (`provider.py:77`) is `(self, adapter, super_properties=None)`; add two keyword params: `allowlist: frozenset[str] | None = None` and `on_violation: ViolationPolicy = "throw"`, stored as `self._allowlist` / `self._on_violation`. Defaults preserve every existing direct-construction test (`Analytics(adapter)` stays valid, guard inactive).
- Wire `enforce_allowlist` into the PY2-S2 provider call-boundary seam at each guarded verb — the gate PY2-S2 left as a call-site: **AFTER the `if self._opted_out: return` consent guard, BEFORE minting the `NeutralEvent`**. Gate the consumer-supplied bags only:
  - `capture(distinct_id, event, properties=None, ...)` → gate the **merged bag** returned by `_merge_super_properties(properties)` (config-time super-props are consumer-supplied, so they cross the gate). Gate the merged result rather than the raw `properties` arg, so super-prop keys are covered even when `properties is None` (the merge yields `dict(super_properties)` in that case — `provider.py:179`). Compute the merge, gate it, and pass the same merged bag to the mint — do not merge twice.
  - `set(distinct_id, traits, once=False)` → gate `traits` (the raw trait bag, BEFORE it is nested under the `set`/`set_once` wrapper — gate the consumer keys, not the library-computed wrapper key).
  - `set_group_traits(group_type, group_key, traits)` → gate `traits` (the raw trait bag, BEFORE it is nested under `group_set` and BEFORE the `group_type`/`group_key` routing keys are added).
  - **Routing identifiers are NOT gated:** `distinct_id`, `event` (the name), `group_type`, `group_key` are identity/routing, not consumer prop keys. The library-computed wrapper keys (`set`/`set_once`/`group_type`/`group_key`/`group_set`) are NOT gated either — they are computed, not consumer-supplied (gate the inner `traits`, never the wrapped `properties` dict the mint builds).
  - **On a `drop-and-error-log` drop (`enforce_allowlist` returns `False`): early-return from the verb before minting** — the event is dropped, `adapter.capture` is never called. On `throw`, the raised error propagates out of the verb (no mint). Resolve the gate through one small provider helper so the three verbs don't each re-implement the drop/short-circuit.
- The factory (`create_analytics`, `factory.py:33`) resolves `config.allowlist` → `frozenset(config.allowlist)` when non-`None` else `None`, plus `config.on_violation`, and threads both into the extended `Analytics(...)` constructor alongside the existing `super_properties`.

### Out

- `derive_allowlist_from_taxonomy` — needs the taxonomy registry SHAPE → **PY3-S2**.
- The runtime taxonomy registry / `define_taxonomy` / reserved-name discipline — **PY3-S2**.
- The best-effort static typing layer (`TypedDict`/`Literal`/generic surface) — **PY3-S3**.
- Nested/deep-key allowlisting — top-level keys only (the same deliberate limitation as TS E3-S2; see Technical notes).
- Any adapter-level re-enforcement — the guard lives ONLY at the provider call-boundary.

## Acceptance criteria

- [ ] `enforce_allowlist` is a pure function (not a Pydantic model/validator); `enforce_allowlist(frozenset({"plan"}), "throw", {"plan": "pro"})` returns `True` standalone (no provider needed).
- [ ] `None` allowlist ⇒ inactive (every key passes, returns `True`); an explicit **empty** `frozenset()` ⇒ ACTIVE (allow-nothing — every key is off-list and fails). The activation predicate is `allowlist is not None`, NOT `len(allowlist) > 0` (mirrors TS `!== undefined`; PY3-S2's derive can return an empty set).
- [ ] `throw` raises naming the off-list key with the exact message `analytics-kit: property "<key>" is not on the payload allowlist`; `drop-and-error-log` logs once and returns `False`, no raise; multi-bag short-circuits on the FIRST off-list key; a `None` bag is skipped.
- [ ] `enforce_allowlist` inspects KEYS only, never values (a value difference never changes the verdict).
- [ ] The provider gates the **merged** `properties` (incl. `super_properties`) on `capture`, and the **inner `traits`** on `set`/`set_group_traits` (gated BEFORE nesting under `set`/`set_once`/`group_set`). It does NOT gate `distinct_id`/`event`/`group_type`/`group_key`, NOR the library-computed wrapper keys (`set`/`set_once`/`group_type`/`group_key`/`group_set`). A rejected event never reaches `adapter.capture` — assert against the recording adapter fixture (the `_RecordingAdapter` shape from `tests/test_provider.py`, never a real backend).
- [ ] A super-prop key absent from `properties` is still gated: with `super_properties={"secret": 1}`, `allowlist=["plan"]`, `on_violation="throw"`, a `capture("u1", "e", {"plan": "pro"})` throws naming `secret` (the merged bag carries it). Symmetrically, a super-prop key ON the allowlist passes when `properties` supplies none of its own.
- [ ] Both policy branches hold at the verb boundary for all three gated verbs: `throw` propagates the error out of `capture`/`set`/`set_group_traits` (no mint); `drop-and-error-log` logs once, the verb returns `None` early, and `adapter.capture` is never called (recording adapter stays empty).
- [ ] The guard runs regardless of consent state ordering as specified (after opt-out early-return, before minting) — a policy violation surfaces loudly even conceptually (a config/programming error).
- [ ] `AnalyticsConfig` carries `allowlist: list[str] | None = None` + `on_violation: ViolationPolicy = "throw"` (additive; `extra="forbid"` accepts them).
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token in `allowlist.py` / provider surface / docstrings; `grep -ri posthog analytics_kit/allowlist.py analytics_kit/provider.py` clean.

## Technical notes

- **CONTRACT reference (ported, not de-branded):** `ts/packages/analytics-kit/src/allowlist.ts` (the `enforceAllowlist` function) + the pinned semantics in `ts/packages/analytics-kit/src/allowlist.test.ts`. **posthog-python has NO allowlist** — this is the library's own surface, ported from TS. The exact behaviors to replicate (from the pinned test): undefined⇒inactive; `[]`⇒active/allow-nothing; keys-only (values never inspected); throw message format; drop-and-error-log returns `False` + logs once; multi-bag short-circuit on first off-list key; undefined-bag skipped; empty allowlist activates.
- **NOT Pydantic — a bespoke key-membership check.** — architect (2026-07-09, Cluster 2): the allowlist is a plain function inspecting `dict.keys()` against a `frozenset`, with the `ViolationPolicy`. Pydantic is ONLY at the config-parse boundary (PY2-S3), never here.
- **Gate position = the PY2-S2 call-boundary seam, PRE-mint.** PY2-S2 established WHERE the gate sits (each verb's call-boundary, after the opt-out early-return, before minting the `NeutralEvent`). This story implements it. The TS rule holds cross-language: **keys the library COMPUTES are trusted** (enrichment/wire keys added downstream by the adapter never reach the gate); **keys/values the consumer SUPPLIES are gated** (`properties`, `traits`, and the consumer-supplied `super_properties`). Routing identifiers (`distinct_id`/`event`/`group_type`/`group_key`) are identity, not gated prop keys.
- **`super_properties` ARE gated** — they are consumer-supplied (config-time dict, PY2-S2), so per the computed-vs-supplied rule they cross the gate. Gate the **merged bag** (`_merge_super_properties(properties)`, `provider.py:179`) once, then pass that same bag to the mint — do NOT merge, gate, and merge again. Gating the raw `properties` arg would MISS super-prop keys when `properties is None`, because the merge only materializes them in that branch. (You may equivalently pass `super_properties` + `properties` as two variadic bags to `enforce_allowlist` — the keys-only variadic contract accepts either — but gating the single merged bag is the cleaner call-site.)
- **`ViolationPolicy` lives in `allowlist.py`; `config.py` imports it (never the reverse).** `AnalyticsConfig` needs the `ViolationPolicy` alias for its `on_violation` field type, so `config.py` imports from `allowlist.py`. Keep `allowlist.py` free of any `config.py` import — the allowlist function takes a resolved `frozenset | None` + policy as ARGS, it never reads config. This one-way edge avoids an import cycle (both are under `from __future__ import annotations`, but the field-type reference is a real runtime import for Pydantic).
- **Provider constructor extension is the wiring seam, not a new adapter member.** The allowlist + policy reach the provider via two new keyword `__init__` params (defaulted, so PY2's `Analytics(adapter)` direct-construction tests are untouched), threaded by `create_analytics`. No adapter-SPI change, no new seam member — the gate is a provider-internal concern, exactly as the consent switch is.
- **Log sink** (the Python analog of the TS typed `console.error` sink): use the stdlib `logging` module — a module logger `logging.getLogger("analytics_kit")` `.error(message)`. Resolve/emit in one small internal helper (the analog of TS's `emitViolation`), not scattered per verb. `.error` severity (the throw-analogue).
- **Top-level keys only (deliberate limitation, carried from TS E3-S2):** the guard gates `bag.keys()` at the top level; a nested `{"user": {"ssn": ...}}` with `user` on-list passes `ssn` through nested. By-design, not a defect — deep-key allowlisting is a future design extension (its own story), not a PY3 fix. Record it so the boundary is explicit.
- **Neutrality lesson from PY1/PY2 — docstrings ship** vendor-neutral in the wheel; only dev-only `#`-comments carry `# de-branded from …` provenance (and here it's PORTED from TS, not de-branded from posthog — no posthog analogue exists).

## Shipped

> Captured by `implement-epics` on 2026-07-10.

- **Files changed:** `python/src/analytics_kit/allowlist.py` (filled: `enforce_allowlist` + `ViolationPolicy` + `_emit_violation` log helper), `config.py` (+`allowlist`/`on_violation`), `provider.py` (`__init__` +`allowlist`/`on_violation`, `_allowed` helper, gate wired into all 3 verbs), `factory.py` (frozenset threading), `__init__.py` (exports)
- **Files added:** `python/tests/test_allowlist.py` (32 cases)
- **New public API:** `enforce_allowlist(allowlist, on_violation, *bags) -> bool`, `ViolationPolicy = Literal["throw","drop-and-error-log"]`, `AnalyticsConfig.allowlist`/`on_violation`, `Analytics(..., *, allowlist=None, on_violation="throw")`. `throw` raises `ValueError`.
- **Tests added:** standalone `enforce_allowlist` semantics + provider-gating (merged super-props, inner-traits, routing/wrapper non-gating, both policy branches ×3 verbs, consent ordering)
- **Commit:** `core-cycle` (message = story title)
- **Reviewer notes:** clean — merged-super-props leak class negative-controlled (a super-prop-only off-list key throws even when `properties is None`; no leak). One suggestion resolved with **no change**: keep plain `ValueError` for `throw` (parity with TS's plain `Error`; `throw` is a terminal config error — the `drop-and-error-log` policy is the graceful path, so a catchable bespoke type would invite swallowing the signal; `AllowlistViolationError(ValueError)` can be added later non-breaking if ever needed).
- **Cross-story seams exposed:** **S2**'s `derive_allowlist_from_taxonomy` returns a container the factory folds into the same `frozenset` the gate consumes (empty result stays ACTIVE — activation is `is not None`). **Never-auto-derive boundary preserved**: the factory reads only `config.allowlist`; a `config.taxonomy` must NOT auto-populate it — S2's derive is an explicit consumer-side call. Deliberate limitation: **top-level keys only** (nested `{"user": {"ssn": ...}}` with `user` on-list passes `ssn` — by-design, noted in `allowlist.py`).
