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
- Extend `AnalyticsConfig` (PY2-S3 Pydantic model) additively: `allowlist: list[str] | None = None` and `on_violation: ViolationPolicy = "throw"`. Because PY2-S3 sets `extra="forbid"`, these become known fields.
- Wire `enforce_allowlist` into the PY2-S2 provider call-boundary seam at each guarded verb — the gate PY2-S2 left as a call-site: **AFTER the `if self._opted_out: return` consent guard, BEFORE minting the `NeutralEvent`**. Gate the consumer-supplied bags only:
  - `capture(distinct_id, event, properties=None, ...)` → gate `properties` **AND the merged `super_properties`** (config-time super-props are consumer-supplied, so they cross the gate).
  - `set(distinct_id, traits, once=False)` → gate `traits`.
  - `set_group_traits(group_type, group_key, traits)` → gate `traits`.
  - **Routing identifiers are NOT gated:** `distinct_id`, `event` (the name), `group_type`, `group_key` are identity/routing, not consumer prop keys.
- The factory (PY2-S3) resolves `config.allowlist` (→ `frozenset` or `None`) + `config.on_violation` into the provider.

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
- [ ] The provider gates `properties` (incl. merged `super_properties`) on `capture`, `traits` on `set`/`set_group_traits`; it does NOT gate `distinct_id`/`event`/`group_type`/`group_key`. A rejected event never reaches `adapter.capture`/`set`/`group` (assert against a spy adapter, never a real backend).
- [ ] The guard runs regardless of consent state ordering as specified (after opt-out early-return, before minting) — a policy violation surfaces loudly even conceptually (a config/programming error).
- [ ] `AnalyticsConfig` carries `allowlist: list[str] | None = None` + `on_violation: ViolationPolicy = "throw"` (additive; `extra="forbid"` accepts them).
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token in `allowlist.py` / provider surface / docstrings; `grep -ri posthog analytics_kit/allowlist.py analytics_kit/provider.py` clean.

## Technical notes

- **CONTRACT reference (ported, not de-branded):** `ts/packages/analytics-kit/src/allowlist.ts` (the `enforceAllowlist` function) + the pinned semantics in `ts/packages/analytics-kit/src/allowlist.test.ts`. **posthog-python has NO allowlist** — this is the library's own surface, ported from TS. The exact behaviors to replicate (from the pinned test): undefined⇒inactive; `[]`⇒active/allow-nothing; keys-only (values never inspected); throw message format; drop-and-error-log returns `False` + logs once; multi-bag short-circuit on first off-list key; undefined-bag skipped; empty allowlist activates.
- **NOT Pydantic — a bespoke key-membership check.** — architect (2026-07-09, Cluster 2): the allowlist is a plain function inspecting `dict.keys()` against a `frozenset`, with the `ViolationPolicy`. Pydantic is ONLY at the config-parse boundary (PY2-S3), never here.
- **Gate position = the PY2-S2 call-boundary seam, PRE-mint.** PY2-S2 established WHERE the gate sits (each verb's call-boundary, after the opt-out early-return, before minting the `NeutralEvent`). This story implements it. The TS rule holds cross-language: **keys the library COMPUTES are trusted** (enrichment/wire keys added downstream by the adapter never reach the gate); **keys/values the consumer SUPPLIES are gated** (`properties`, `traits`, and the consumer-supplied `super_properties`). Routing identifiers (`distinct_id`/`event`/`group_type`/`group_key`) are identity, not gated prop keys.
- **`super_properties` ARE gated** — they are consumer-supplied (config-time dict, PY2-S2), so per the computed-vs-supplied rule they cross the gate. Gate them alongside `properties` on `capture` (the merged bag, or as a second variadic bag — either satisfies the keys-only variadic contract).
- **Log sink** (the Python analog of the TS typed `console.error` sink): use the stdlib `logging` module — a module logger `logging.getLogger("analytics_kit")` `.error(message)`. Resolve/emit in one small internal helper (the analog of TS's `emitViolation`), not scattered per verb. `.error` severity (the throw-analogue).
- **Top-level keys only (deliberate limitation, carried from TS E3-S2):** the guard gates `bag.keys()` at the top level; a nested `{"user": {"ssn": ...}}` with `user` on-list passes `ssn` through nested. By-design, not a defect — deep-key allowlisting is a future design extension (its own story), not a PY3 fix. Record it so the boundary is explicit.
- **Neutrality lesson from PY1/PY2 — docstrings ship** vendor-neutral in the wheel; only dev-only `#`-comments carry `# de-branded from …` provenance (and here it's PORTED from TS, not de-branded from posthog — no posthog analogue exists).

## Shipped

<!-- Captured by implement-epics on close. -->
