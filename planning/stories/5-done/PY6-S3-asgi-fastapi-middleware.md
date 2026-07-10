---
id: PY6-S3-asgi-fastapi-middleware
epic: PY6-RCT-framework-bindings
status: ready-for-dev
area: react
touches: [node]
depends_on: [PY6-S1-context-core-and-scoped-view]
api_impact: additive
---

# PY6-S3-asgi-fastapi-middleware — ASGI/FastAPI request-scoped context middleware (`[fastapi]` extra)

## Why

The ASGI/FastAPI middleware is the async-server half of the framework bindings — the same thin `new_context()`-per-request wrapper as Django (PY6-S1/S2), but for ASGI apps (FastAPI, Starlette). Together with Django it covers the two real Python deployment shapes (WSGI + ASGI) at near-zero incremental cost (both are `new_context` wrappers). It is gated behind `analytics-kit[fastapi]` and imports its framework lazily. Depends only on PY6-S1, so it builds in parallel with the Django track.

## Scope

### In

- `analytics_kit/integrations/fastapi.py` (or `integrations/asgi.py` — builder's call; ASGI middleware works for FastAPI + Starlette) — an ASGI middleware that opens a `new_context()` (PY6-S1) around each request and restores the prior context after the response. Preferred shape: a **pure ASGI-3 middleware** — `def __init__(self, app)` + `async def __call__(self, scope, receive, send)` that wraps `await self.app(scope, receive, send)` in `with new_context(): ...` (open the scope, then await downstream inside it). Pure ASGI-3 needs NO framework import (ASGI is a protocol) → the `[fastapi]` extra gates the DOCUMENTED integration path, and the lazy-import guard applies only if the builder instead subclasses Starlette's `BaseHTTPMiddleware` (see AC — pin which). The `async def __call__` is the ASGI **protocol** signature, NOT an async client — it does NOT violate the PY2-S4 fence (no `asyncio` module, no event loop created here, no async client). A `capture(...)` in the handler offloads delivery to the background thread (PY2-S4), not awaited — so the sync client is fine inside an async server.
- **Lazy framework import** (`try/except ImportError`): Starlette/FastAPI (or just `asgiref` typing) imported INSIDE the module, gated behind the `[fastapi]` extra. Importing `analytics_kit` / `analytics_kit.integrations` without the extra never imports the framework; a clear error is raised only if the middleware is USED without it.
- **`[fastapi]` extra** — already declared in `pyproject.toml` (PY1-S1). This story fills the binding.
- **Consumer tags only, all gated** (per PY6-S1 + the architect ruling): same posture as Django — the consumer binds distinct_id/tags; no library-computed metadata auto-attached.
- The `[all]` extra (PY1-S1) already unions `[django]` + `[fastapi]`.

### Out

- The `contextvars` core / `@scoped` / context-aware capture — **PY6-S1**.
- The Django middleware — **PY6-S2**.
- Auto-attaching library-computed request metadata — out of PY6 scope.
- Flask / Celery bindings — deferred (PM-locked).
- An async client — NOT this cycle (the sync client works inside an async server; delivery is thread-offloaded, PY2-S4). Making the client itself async is an additive future.
- Any modification to the shipped `provider.py` — untouched.

## Acceptance criteria

- [ ] `analytics_kit/integrations/fastapi.py` provides an ASGI middleware that opens a `new_context()` per request and restores the prior context after the response (no leak across concurrent requests — `contextvars` is task-local, which is what makes this async-safe).
- [ ] The framework is imported LAZILY: importing `analytics_kit` / `analytics_kit.integrations` with FastAPI/Starlette absent does NOT import it and does NOT error; the middleware raises a clear neutral error only when USED (constructed/called) without it. **Pin the failure mode** (same as S2): module-level `try/except ImportError` → sentinel; the middleware raises a role-named neutral error naming the missing `analytics-kit[fastapi]` extra, NO vendor token, NOT a raw `ModuleNotFoundError`. **Note:** a pure ASGI-3 middleware (`__call__(self, scope, receive, send)`) can be written with NO framework import at all (ASGI is a protocol, not a package) — if the builder writes it framework-free, the lazy-import guard may be N-A; in that case the test asserts the middleware constructs + runs with NO `[fastapi]` extra installed (even stronger than the monkeypatch path). Pin which: framework-free ASGI-3 (no import to guard) OR a Starlette `BaseHTTPMiddleware` subclass (needs the lazy Starlette import + guard). Builder's call, but the AC must match whichever is chosen.
- [ ] `integrations/__init__.py` stays import-safe with no extra installed (a bare `import analytics_kit.integrations` must never pull FastAPI/Starlette); any middleware re-export is lazy/guarded.
- [ ] A `capture(...)` inside an async handler under the middleware resolves against the request-bound distinct_id + tags (integration test with the framework installed via the dev group).
- [ ] The middleware carries consumer tags only (all gated); no library-computed metadata auto-attached.
- [ ] The shipped `provider.py` is UNCHANGED.
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] The middleware's `async def __call__` is the ASGI PROTOCOL signature (or Starlette dispatch), NOT an async client: no `asyncio` module import, no event loop created in the binding, no async delivery — `capture(...)` stays sync + thread-offloaded (PY2-S4 fence holds; the fence protects the CLIENT posture, not the ASGI protocol handler an async server requires).
- [ ] Zero vendor token in the middleware name / exports / **docstrings** (docstrings ship in the wheel); `grep -ri posthog analytics_kit/integrations/fastapi.py` is CLEAN (match PY1–PY5 — src fully `posthog`-grep-clean; provenance in planning, not code; PY8 `#`-exemption available but unused). Do NOT require a `posthog`-bearing comment.

## Technical notes

- **⚠ TEST-INFRA DECISION (PM-locked — same wrinkle as PY6-S2):** the middleware tests need FastAPI/Starlette INSTALLED, but it's a consumer EXTRA, not a dev-dep. **Pin both:**
  1. **Add `fastapi` (or `starlette`) to `[dependency-groups] dev`** so `uv run pytest` HAS it and exercises the real middleware. The runtime `try/except ImportError` lazy path stays real for consumers (the extra gates install; the dev-dep only affects the test env).
  2. **The "consumer WITHOUT the extra" path** — depends on the shape chosen (see AC): if the builder writes a Starlette `BaseHTTPMiddleware` subclass (needs a framework import), test absence by **monkeypatching that import to raise `ImportError`** — assert `import analytics_kit.integrations` still succeeds and using the middleware raises the clear neutral error. If the builder writes a **pure ASGI-3 middleware (no framework import)**, there is nothing to monkeypatch — instead assert the middleware constructs + runs a request WITHOUT `[fastapi]` needing to be present (a stronger proof; the `[fastapi]` extra then gates only the documented FastAPI wiring, not the middleware's own imports). Either way: `import analytics_kit.integrations` must succeed with no extra installed.
- **`contextvars` is task-local → async-safe.** The reason the same `new_context()` core works for concurrent async requests is that `contextvars` are copied per asyncio task — each request's context is isolated. This is the exact property that makes the ASGI middleware a thin wrapper over the SAME PY6-S1 core, no async-specific context machinery needed.
- **Sync client inside an async server is fine** (architect, epic Notes; PY2-S4): a `capture(...)` in an async handler enqueues onto the background-thread consumer — the send is offloaded, not awaited — so the locked sync-client posture works within FastAPI/Starlette. No async client is needed for R-parity.
- **CONTRACT reference (port TO):** the TS React provider's per-request scoping (`ts/packages/react/src/*`). **DE-BRAND FROM (idiom):** posthog-python's ASGI/context handling (`contexts.py` + the lazy `asgiref` import in `integrations/django.py`) — the lazy-import + `new_context`-wrapper pattern.
- **Lazy import + extra** (architect, epic Notes): same as PY6-S2 — the framework is imported inside the module, gated behind `[fastapi]`, optional (the PY4 client works standalone). Bar B: adopt by config + `pip install analytics-kit[fastapi]`, zero library change.
- **Role-named, no vendor token.** The library assumes no FastAPI auth/user model — the consumer binds distinct_id/tags.
- **Neutrality lesson (PY1–PY5) — docstrings ship** vendor-neutral, and the src stays fully `posthog`-grep-clean (shipped `# De-branded ...` comments are worded without the token). Role-named middleware, no vendor token. Port provenance lives in this story, not the code.

## Shipped

> Captured by `implement-epics` on 2026-07-10.

- **Files added:** `python/src/analytics_kit/integrations/asgi.py` (`RequestContextASGIMiddleware`, pure ASGI-3), `tests/test_asgi_middleware.py` (17 cases)
- **Files changed:** `integrations/__init__.py` (`_LAZY_EXPORTS` + `__all__` extended), `pyproject.toml` (+`starlette>=0.37`, `httpx` in `[dependency-groups] dev` only), `uv.lock`
- **New public API:** `RequestContextASGIMiddleware` (pure ASGI-3, framework-free; `async def __call__(scope, receive, send)` wrapping `await self.app(...)` in `new_context()`)
- **Tests added:** interleaved concurrent async-safety (task-local, distinct scope identities), framework-free-import (subprocess meta-path block + the `'…integrations.asgi' not in sys.modules` hardening), the ASGI-protocol-signature guard, consumer-tags-only, provider-unchanged
- **Commit:** `core-cycle` (message = story title)
- **Reviewer notes:** clean — the concurrent async-safety proof is **genuinely interleaved** (an `anyio.Event` handshake: A parks mid-request while B binds a different id + captures; distinct `ContextScope` `id()`s; 20/20 looped); framework-free import independently confirmed (constructs+runs a request with the frameworks blocked — stronger than monkeypatch since ASGI is a protocol); `provider.py` diff 0 bytes; no asyncio in src (the fence test matches loop mechanics, not the word). The pure-ASGI-3 choice makes `[fastapi]` honestly gate only the documented wiring.
> Reviewer suggestion (2026-07-10): (a) early-return for non-`http` scopes — `if scope["type"] != "http": return await self.app(scope, receive, send)` — so the middleware doesn't open a request context for `lifespan` (app-lifetime) / `websocket` scopes; benign today (empty scope, no leak) but tighter to intent. (b) quiet the external `StarletteDeprecationWarning` (httpx/`TestClient`) via a scoped `filterwarnings` or by driving the test through `httpx.ASGITransport` directly. (Both improvement-pass.)
- **Cross-story seams exposed:** PY6 framework-bindings is COMPLETE — S1 (task-local `contextvars` core + `@scoped` + `context(analytics)` view) → S2 (Django/WSGI middleware) → S3 (ASGI/async middleware); the two real Python deployment shapes covered as thin framework-gated `new_context()` wrappers over one shared core, sync-client fence + neutrality intact. PY7's example exercises a binding; PY8 audits framework-bindings vs TS E9 (React) as the idiomatic server analog.

## Follow-up

> PY6 post-close improvement pass, 2026-07-10 (spanning S2 + S3 residuals).

- **(S3 src) Non-`http` scope early-return** — `RequestContextASGIMiddleware.__call__` now passes `lifespan`/`websocket` scopes straight through (`if scope["type"] != "http": return await self.app(...)`), opening the request context only for HTTP requests; a test asserts a non-`http` scope isn't wrapped.
- **(S3 test) Quieted the `StarletteDeprecationWarning`** by driving the ASGI integration test through `httpx.ASGITransport` directly (dropping the Starlette `TestClient`/httpx coupling) — `uv run pytest` is now 0-warnings (384 passed).
- **(S2 test) Hardened the lazy-import pin** — the django bare-import test now asserts `'analytics_kit.integrations.django' not in sys.modules`, so it fails on an eager-import regression (the `'django' not in sys.modules` check alone would pass under one). Gates green (mypy strict 47 · ruff · pytest 384 · 0 warnings · neutrality clean).
