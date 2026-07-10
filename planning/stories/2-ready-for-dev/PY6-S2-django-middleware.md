---
id: PY6-S2-django-middleware
epic: PY6-RCT-framework-bindings
status: ready-for-dev
area: react
touches: [node]
depends_on: [PY6-S1-context-core-and-scoped-view]
api_impact: additive
---

# PY6-S2-django-middleware — Django request-scoped context middleware (`[django]` extra)

## Why

The Django middleware is the WSGI half of the framework bindings — a thin wrapper that opens a `new_context()` (PY6-S1) around each request so a Django view can `capture(...)` against the request's distinct id + tags without threading them. It is gated behind the `analytics-kit[django]` extra and imports Django lazily, so a consumer without the extra never imports Django. It is the Python realization of the React provider's per-request scoping, de-branded from `posthog-python/posthog/integrations/django.py`.

## Scope

### In

- `analytics_kit/integrations/django.py` — a Django middleware (the `PosthogContextMiddleware` analog, role-named, no vendor token) that, per request, opens a `new_context()` (PY6-S1) for the duration of the request and closes it after the response. The middleware follows Django's callable-middleware shape: `__init__(self, get_response)` stores the next handler, and a **synchronous** `__call__(self, request)` wraps `self.get_response(request)` in a `with new_context(): ...` block (WSGI-sync — S3 owns ASGI/async; do NOT port the reference's hybrid `sync_capable`/`async_capable` dual `__call__`/`__acall__` — that async half is S3's domain and pulls `asgiref`/`markcoroutinefunction` machinery out of scope here). A consumer sets the request's `distinct_id` (via the S1 scope accessor) and any `add_tag(...)` inside the context — the middleware provides the scope; the consumer decides what identity/tags to bind (the library never assumes a Django user model, never reads `request.user`, never extracts headers — that's the flat-tag-bag the ruling drops).
- **Lazy Django import** (`try/except ImportError`, mirroring posthog-python's `django.py` lazy `asgiref` import): Django is imported INSIDE `integrations/django.py`, so importing `analytics_kit` or `analytics_kit.integrations` (without the `[django]` extra) never imports Django. A clear error is raised only if the Django middleware is actually USED without Django installed.
- **`[django]` extra** — already declared in `pyproject.toml` (PY1-S1). This story fills the binding the extra gates.
- **Consumer tags only, all gated** (per PY6-S1 + the architect ruling): the middleware carries CONSUMER-supplied tags through the PY6-S1 gated lane; it does NOT auto-attach library-computed request metadata (route/request-id) — that's a deliberate out-of-scope additive follow-up.

### Out

- The `contextvars` core / `@scoped` / the context-aware capture path — **PY6-S1** (this story drives it per request).
- The ASGI/FastAPI middleware — **PY6-S3**.
- Auto-attaching library-computed request metadata (`$current_url`/route/request-id) — out of PY6 scope (the flat consumer+computed bag posthog-python uses is explicitly NOT ported).
- Flask / Celery bindings — deferred (PM-locked).
- Any modification to the shipped `provider.py` — untouched.

## Acceptance criteria

- [ ] `analytics_kit/integrations/django.py` provides a Django middleware that opens a `new_context()` per request and restores the prior context after the response (no context leak across requests).
- [ ] Django is imported LAZILY inside `integrations/django.py`: importing `analytics_kit` / `analytics_kit.integrations` with Django absent does NOT import Django and does NOT error; the middleware raises a clear neutral error only when USED (constructed/called) without Django installed. **Pin the failure mode:** the module-level `try/except ImportError` sets a sentinel (e.g. `_DJANGO_AVAILABLE = False`), and the middleware's `__init__` (or first use) raises a role-named neutral error — a clear `ImportError`/`RuntimeError` whose message names the missing extra ("...requires the `analytics-kit[django]` extra") and carries NO vendor token. Do NOT let a raw `ModuleNotFoundError: No module named 'django'` surface — wrap it.
- [ ] `integrations/__init__.py` does NOT eagerly import `django` (or `fastapi`) — it stays import-safe with no extra installed (a bare `import analytics_kit.integrations` must never pull a framework). If it re-exports the middlewares, the re-export must be lazy/guarded, not a top-level `from .django import ...`.
- [ ] A consumer can bind a `distinct_id` + tags inside the middleware's context and a `capture(...)` in a view resolves against them (integration test with Django installed via the dev group — see Technical notes).
- [ ] The middleware carries consumer tags only (all gated); it does NOT auto-attach library-computed request metadata.
- [ ] The shipped `provider.py` is UNCHANGED.
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token in the middleware name / exports / **docstrings** (docstrings ship in the wheel); `grep -ri posthog analytics_kit/integrations/django.py` is CLEAN (match PY1–PY5 — src stays fully `posthog`-grep-clean; provenance lives in planning, not the code; the PY8 `#`-exemption is available but unused per convention). Do NOT require a `posthog`-bearing comment.

## Technical notes

- **⚠ TEST-INFRA DECISION (PM-locked — the real wrinkle):** the middleware tests need Django INSTALLED, but `django` is a consumer EXTRA (`[project.optional-dependencies]`), not a dev-dep — so the default `uv run pytest` env doesn't have it. **Pin both:**
  1. **Add `django` to `[dependency-groups] dev`** in `pyproject.toml` so the standard `uv run pytest` env HAS Django and exercises the real middleware (mirrors how TS `E9-S1` added React devDeps to run tests while React stayed a peer). The runtime `try/except ImportError` lazy path stays REAL for consumers (the extra still gates it at install time; the dev-dep only affects the test env).
  2. **The "consumer WITHOUT the extra never imports Django" path is tested by monkeypatching the import to raise `ImportError`** (since the dev env WILL have Django, you can't test absence by not-installing — you simulate it): a test that monkeypatches/mocks the Django import inside `integrations/django.py` to raise `ImportError`, asserts importing `analytics_kit.integrations` still succeeds, and asserts using the middleware raises the clear neutral error.
- **CONTRACT reference (port TO):** the TS React provider's per-request scoping intent (`ts/packages/react/src/*`). **DE-BRAND FROM (idiom):** `posthog-python/posthog/integrations/django.py` — the `PosthogContextMiddleware` shape + the lazy `asgiref`/framework import pattern. **Do NOT port** its flat consumer+computed tag bag (`django.py:162-220`, the `_build_tags` method — `$current_url`/`$request_method`/`$request_path`/`$ip`/`$user_agent`/`email` injection + header/`request.user` extraction) — PY6 carries consumer tags only through the gated lane (architect ruling, PY6-S1).
- **Lazy import pattern** (architect, epic Notes): Django imported inside the module (`try/except ImportError`), gated behind the extra. A consumer without `[django]` never imports Django — this is how one distribution + extras satisfies "adopt only what you need" (PY1). The middleware is OPTIONAL — the PY4 client works standalone with no framework installed (bar B).
- **Role-named, no vendor token:** the middleware class name names no vendor. The library never assumes a Django user/auth model — the consumer binds the distinct_id/tags.
- **Neutrality lesson (PY1–PY5) — docstrings ship** vendor-neutral, and the src stays fully `posthog`-grep-clean (shipped `# De-branded ...` comments are worded without the token). The class name is role-named (no vendor token) — the reference is `PosthogContextMiddleware`; the port strips the vendor prefix (e.g. a `RequestContextMiddleware`-style role name — builder's call, no vendor token). Port provenance lives in this story, not the code.

## Shipped

<!-- Captured by implement-epics on close. -->
