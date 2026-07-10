---
id: PY6-S1-context-core-and-scoped-view
epic: PY6-RCT-framework-bindings
status: ready-for-dev
area: react
touches: [node]
depends_on: []
api_impact: additive
---

# PY6-S1-context-core-and-scoped-view — `contextvars` request scope, `@scoped`, and the context-aware capture path

## Why

The `contextvars` request scope is the server analog of the React provider/hooks: it carries a `distinct_id` + super-prop-like tags per request/task, so a request handler can `capture("event", {...})` without threading the distinct id through every call. This story builds the framework-agnostic context core (the middleware in S2/S3 just drives it) + the context-aware capture entry that reads it — WITHOUT mutating the shipped seam provider (the architect ruling). It is the Python realization of TS `E9-S2` (the create-once client + context-scoped identity pattern), server-shaped, de-branded from `posthog-python/posthog/contexts.py`.

## Scope

### In

- `analytics_kit/integrations/context.py` (fills the empty PY1 `integrations/` package) — the framework-agnostic `contextvars` stack, de-branded from `posthog-python/contexts.py` (keep ONLY `distinct_id` + `tags`; drop the exception-autocapture / session-id / device-id / code-variables machinery — PostHog error-tracking + browser concepts with no server-neutral home):
  - A module-private `ContextVar` holding the active context scope (a small `ContextScope` object carrying `distinct_id: str | None` + `tags: dict[str, object]`).
  - `new_context(...)` — a `@contextmanager` that opens a fresh (or child) scope, yields it, and restores the previous scope on exit (the posthog-python `new_context` pattern; `contextvars` token reset).
  - Accessors: set/read the active `distinct_id`, `add_tag(key, value)` to add a request-scoped tag, and a current-context reader.
  - `@scoped` — a decorator that wraps a function in a `new_context()` (the posthog-python `@scoped` pattern) so a task/handler runs inside a fresh context.
- **The context-aware capture path** (the #4 architect ruling — Option B + context read in the binding layer, NOT the seam provider):
  - A context-aware entry (a `context()`-scoped view or a thin capture helper in `integrations/context.py`) that reads the active context and calls the SHIPPED provider's unchanged `capture(resolved_distinct_id, event, {**tags, **properties})`:
    - resolves `distinct_id` = the explicit call arg if given, else the active context's `distinct_id`; **raises a clear neutral error** ("no active analytics context and no explicit distinct_id") when NEITHER is present (the binding raises — the base provider's required-arg contract is untouched).
    - merges the context tags into `properties` with precedence `super_properties → tags → call-time properties` (later wins) — see Technical notes for the exact order.
  - **The shipped `provider.py` is NOT modified** — it stays context-agnostic; the context read lives entirely in this binding layer.

### Out

- The Django middleware — **PY6-S2** (drives `new_context()` per request).
- The ASGI/FastAPI middleware — **PY6-S3**.
- Any modification to the shipped `provider.py` / the seam — explicitly NOT done (the architect ruling; the base provider stays context-agnostic).
- Library-computed context fields (route, request-id, etc.) — **out of PY6 scope** (PM-confirmed): PY6 carries CONSUMER TAGS ONLY, all gated. Auto-attaching library-computed request metadata is a deliberate additive follow-up (it introduces a computed-not-supplied lane that attaches after the gate).
- Flask / Celery bindings — deferred (PM-locked, additive-by-config).

## Acceptance criteria

- [ ] `new_context()` opens a fresh context scope carrying `distinct_id` + `tags`, yields it, and restores the previous scope on exit (nesting works; `contextvars` token reset — no leak across requests).
- [ ] `@scoped` runs a decorated function inside a fresh `new_context()`.
- [ ] `add_tag(k, v)` adds a request-scoped tag readable within the active context.
- [ ] The context-aware capture entry resolves `distinct_id` = explicit arg else active-context `distinct_id`; with NEITHER present it raises a clear neutral error (from the binding — NOT a silent no-distinct-id capture, NOT a personless-UUID fallback).
- [ ] Context tags merge into `properties` with precedence `super_properties → tags → call-time properties` (a call-time prop overrides a tag overrides a super-prop); consumer tags **cross the allowlist gate** (an off-list tag is rejected exactly like an off-list prop); tags also participate in taxonomy validation post-merge.
- [ ] The shipped `provider.py` is UNCHANGED (its `capture` signature + required `distinct_id` untouched); the context read lives in `integrations/context.py`.
- [ ] `contextvars` is the only new stdlib import in the context core; NO asyncio/threading (the fence's forbidden set is not touched).
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token in the context core / decorator / names / docstrings; a dev-only `# De-branded from posthog's contexts.py` provenance comment is allowed (the neutrality-scan exemption); `grep -ri posthog` over `integrations/context.py` finds only that provenance comment (source-level).

## Technical notes

- **#4 ARCHITECT RULING (2026-07-10, dedicated consult, HIGH confidence all three sub-questions) — the load-bearing mechanism:**
  - **(a) `distinct_id` stays REQUIRED on the shipped provider; the context supplies it at the CALL SITE (Option B).** Do NOT widen `capture` to `str | None`. Rejected Option A (widening) because it would either copy PostHog's "personless-UUID" papering (a vendor concept the neutral seam must not adopt — `client.py:133`) or masquerade a required arg as optional (a silent-no-identity footgun). The base provider's "server-shaped: per-call distinct_id, no persisted identity" contract is a deliberate seam guarantee — Option B preserves it. This maps to the React contract: the React provider does NOT mutate the client's `capture` to be context-aware; the context supplies the client/id and hooks read it at the call site.
  - **(b) Tags merge BEFORE the allowlist gate, order `super_properties → tags → call_properties` (later wins).** Concretely `{**super_properties, **tags, **call_properties}`. Consumer tags are consumer-supplied → **gated** (the E3 rule; a tag bypassing the gate would be a privacy hole). Both references agree on call-time-wins precedence (posthog-python `client.py:162-164` `context_tags.update(properties)`; the shipped `_merge_super_properties` `{**super, **props}`). Tags land in `merged` before `validate_event_props`, so a tag whose key collides with a declared event prop IS taxonomy-validated (correct — a tag is a property once merged). **Do NOT port posthog-python's flat consumer+computed tag bag** (`django.py:181-208`) — keep consumer tags in the gated lane; PY6 has no library-computed lane (see Out of scope).
  - **(c) The context read lives in `integrations/context.py` (+ middleware); `provider.py` stays context-agnostic.** The fence PERMITS `contextvars` in `provider.py` (not in the forbidden set), but the seam provider is the WRONG home: request-scoping is ambient identity, the opposite of the provider's per-call/no-ambient-identity contract; coupling the neutral seam to a framework-binding concern is exactly what `integrations/` (the server analog of the react package) exists to avoid. posthog-python folds context into `Client.capture` because it has a monolithic client with no seam to protect — the correct port keeps the `contexts.py` idiom but relocates the CONSUMPTION to the binding layer. Rejected: modifying `provider.py` to read the contextvar (fence-permitted ≠ design-correct).
- **CONTRACT reference (port TO):** `ts/packages/react/src/{analytics-client-provider.tsx,use-analytics.ts,analytics-client-context.ts}` — the create-once-client + context-scoped-identity pattern (context supplies, call-site reads, provider surface not mutated), server-shaped as a `contextvars` scope. **DE-BRAND FROM (idiom):** `posthog-python/posthog/contexts.py` (the `ContextScope`+`contextvars` stack + `@scoped`/`new_context()` `@contextmanager` pattern) — keep `distinct_id`+`tags`, drop the rest.
- **The `context()` verb shape is the TS lib's own** — PY2's architect deferred `context()` → "a request-scoped context manager (see PY6)" to this epic. This story realizes it.
- **Neutrality lesson — docstrings ship** vendor-neutral; only the dev-only `#`-provenance comment carries `posthog` (the scan exemption).

## Shipped

<!-- Captured by implement-epics on close. -->
