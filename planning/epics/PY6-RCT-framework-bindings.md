---
id: PY6-RCT-framework-bindings
status: active
area: react
touches: [node]
api_impact: additive
blocked_by: [PY4-NODE-server-capture]
updated: 2026-07-10
---

# PY6-RCT-framework-bindings — Python framework bindings

## Why

The framework bindings are the Python analog of the React binding — the optional, per-request integration layer that carries identity + tags through a web request the way the React provider/hooks carry them through a component tree. It is the Python realization of TS `E9-RCT-react-binding`, but the *shape* is idiomatic Python: a `contextvars`-based request scope + a decorator + framework middleware, de-branded from `posthog-python`'s `contexts.py` + `integrations/`. Informed by the architect consult (2026-07-09), Cluster 1. The `react` area slug carries this cross-language (framework bindings ARE the optional per-request binding), with `touches: [node]` for the client it drives.

## Success criteria

- A **`contextvars`-based request-scoped context** carries a `distinct_id` + super-prop-like tags per request/task — the server realization of the TS `context()`/`ScopedAnalytics` verb (which carries browser *enrichment* profiles, N-A on a server). One request = one context = one distinct_id + tags.
- A **`@scoped` decorator** opens a context around a function (the posthog-python `contexts.py` pattern).
- **Django middleware** + **ASGI/FastAPI middleware** — both thin wrappers over `new_context()` — covering the two real deployment shapes (WSGI + ASGI). Each is gated behind its extra (`analytics-kit[django]`, `analytics-kit[fastapi]`) and imports its framework **lazily** (`try/except ImportError`), so a consumer who never installs the extra never imports the framework.
- The bindings are **optional** — the core client (PY4) works standalone with no framework installed; the bindings never become a hard dependency. Bar B holds: a new app adopts by config + `pip install analytics-kit[django]`, zero library change.
- Zero vendor references on the binding surface — the middleware/decorator/context names carry no vendor token.

## Stories

Chain — `S1 → {S2, S3}`; S2 and S3 both depend only on S1 (parallel — the two middlewares are the same `new_context` wrapper for WSGI vs ASGI). Written to `stories/2-ready-for-dev/`. Fills the empty PY1 `integrations/` package. **The #4 provider-context mechanism is architect-locked (Option B): the context supplies distinct_id + tags at the CALL SITE via a binding-layer view — the shipped `provider.py` is NOT modified.**

- **[PY6-S1](../stories/2-ready-for-dev/PY6-S1-context-core-and-scoped-view.md)** *(additive, no deps)* — the `contextvars` core (`new_context()` @contextmanager + current-context accessor carrying `distinct_id` + tags + `add_tag`) + the `@scoped` decorator + the context-aware capture path (resolves distinct_id = arg-else-context, raises if neither; merges tags `super_properties → tags → call_properties`, tags gated). `provider.py` untouched.
- **[PY6-S2](../stories/2-ready-for-dev/PY6-S2-django-middleware.md)** *(additive, depends on S1)* — the Django (WSGI) middleware opening a `new_context()` per request, lazy `try/except ImportError` behind `[django]`, consumer tags only (no library-computed metadata).
- **[PY6-S3](../stories/2-ready-for-dev/PY6-S3-asgi-fastapi-middleware.md)** *(additive, depends on S1)* — the ASGI/FastAPI middleware (same `new_context` wrapper, `contextvars` is task-local ⇒ async-safe), lazy import behind `[fastapi]`; the sync client works inside an async server (delivery thread-offloaded).

Build topo order: `PY6-S1 → PY6-S2` and `PY6-S1 → PY6-S3` (S2/S3 parallel).

**Module map** (fills the empty PY1 `integrations/` package; the shipped `provider.py` is NOT modified — the context read lives in the binding layer per the #4 ruling):

- `integrations/context.py` — the `contextvars` stack + `ContextScope` (`distinct_id`+`tags`) + `new_context()` + `@scoped` + the context-aware capture entry (S1)
- `integrations/django.py` — the Django middleware, lazy-imported behind `[django]` (S2)
- `integrations/fastapi.py` (or `asgi.py`) — the ASGI/FastAPI middleware, lazy-imported behind `[fastapi]` (S3)
- `pyproject.toml` `[dependency-groups] dev` gains `django` + `fastapi`/`starlette` (the test-infra decision — the runtime extras/lazy path stays real for consumers)

## Out of scope

- **Flask** and **Celery/task-queue** bindings — deferred (additive-by-config; a third/fourth middleware is a new submodule + extra, zero library change, so "adopt only what you need" covers a later add). See Notes for the scope rationale.
- The browser React binding itself — N-A-by-platform (no browser target in Python).
- The browser `context()` enrichment-profile semantics — N-A; the Python `context()` carries distinct_id + tags, not enrichment toggles.
- AI-framework / other posthog-python integrations — out of BRIEF scope.

## Notes

- **The React pattern maps onto middleware + context-manager + decorator.** — architect (2026-07-09, Cluster 1): posthog-python's `integrations/` ships `django.py` (`PosthogContextMiddleware`) + `celery.py`, both on `contexts.py`'s `contextvars` stack + `@scoped` decorator. The React provider/hooks (create-once client + context-scoped identity) is a component tree; the server equivalent is a request middleware + context manager. The `context()`/`ScopedAnalytics` verb from PY2 is what the middleware drives.
- **PM-locked scope cut (2026-07-09): Django + ASGI/FastAPI IN; Flask + Celery deferred.** Resolves the architect's surviving open question #1. Rationale is the SOTA/parity bar (NOT consumer-pull): Django (WSGI) + ASGI/FastAPI covers the two real deployment shapes, and both are the same near-zero-cost `new_context` wrapper. Flask is a third middleware and Celery a task-queue binding — both additive-by-config (new submodule + extra, zero library change), so deferring them costs nothing and keeps the cycle scoped. If the first real consumer turns out Flask-only or Celery-heavy, adding that binding is a small additive follow-up, not a re-architecture.
- **Lazy framework imports + extras.** — architect (2026-07-09, Cluster 3): each binding imports its framework lazily inside `integrations/` (`try/except ImportError`, as posthog-python's `django.py` does around `asgiref`), gated behind an extra. A consumer without the extra never imports the framework — this is how one distribution + extras satisfies "adopt only what you need."
- **Area slug.** This epic carries the `react` area cross-language (it IS the optional per-request binding, the React analog); `touches: [node]` for the client it drives. Not a new area — the framework-bindings work lives in `react` per the canonical taxonomy.

## Expansion path

A Flask, Celery, or other framework binding is a new submodule + extra under the same single distribution, importing its framework lazily — additive, zero change to the core client or the seam.
