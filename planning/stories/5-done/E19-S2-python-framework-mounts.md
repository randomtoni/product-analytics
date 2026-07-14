---
id: E19-S2-python-framework-mounts
epic: E19-NODE-ingest-receiver-persistence
status: ready-for-dev
area: node
touches: [adapters]
depends_on: [E19-S1-neutral-receiver-core]
api_impact: additive
---

# E19-S2-python-framework-mounts — Django + FastAPI/ASGI receiver mounts (Python), the inbound analog of the request-context middlewares

## Why

The consumer must mount the receiver, not write one. This slice ships the Python framework-idiomatic
mounts — the INBOUND analog of the existing request-context middlewares (`integrations/`) — that wrap
the S1 neutral core so a Django or FastAPI/ASGI app receives the node batch envelope on a route with
zero server logic authored by the consumer. Bar B: adopt by config + mounting the shipped handler.

## Scope

### In

- Ship **Django + FastAPI/ASGI receiver mounts** in Python, REPLICATING the existing request-context
  middleware set's convention (`python/src/analytics_kit/integrations/django.py`, `asgi.py`) — the same
  lazy-import, extra-gated, `__getattr__`-re-exported posture. **PINNED home (architect 2026-07-14):
  alongside the S1 receiver core in `python/src/analytics_kit/receiver/`, NOT `integrations/`.** The
  receiver mounts share a MECHANISM with the `integrations/` middlewares (the lazy-extra-gated framework
  binding convention) but not a SUBJECT — `integrations/` is the DB-agnostic request-context scope layer
  (`new_context`/`scoped`/`context`), whereas the receiver is the self-host WRITE ingest path. One
  capability, one package: `receiver/` holds the core AND its mounts AND S3's factory (mirroring how
  `query/` keeps `db_execute` + `default_db_execute` together). **COPY the `integrations`
  `__getattr__`/extra-gating convention into `receiver/` — do NOT import from or extend the
  `integrations/` package** ("mirrors the integrations pattern" is a convention to replicate, never a
  license to reach into that package).
  - **Django mount** — a view/handler (the receiver analog of `RequestContextMiddleware`) that reads the
    request body + headers, calls the S1 core, and returns a Django `HttpResponse` from the neutral
    outcome (2xx on accept, 4xx on a neutral parse error). Django imported LAZILY behind
    `analytics-kit[django]` (guard + clear neutral `RuntimeError` naming the extra when constructed
    without Django — mirror `django.py:19-24,44-48`). Consumer wires it as a URL route.
  - **FastAPI/ASGI mount** — the async-server analog of `RequestContextASGIMiddleware`. Provide the
    pure-ASGI-3 receiver (imports NO framework — ASGI is a protocol) AND/OR a FastAPI route factory
    behind `analytics-kit[fastapi]`. Follow `asgi.py`'s framework-free posture: the ASGI receiver
    constructs with no extra installed; the FastAPI-specific wiring is what the `[fastapi]` extra gates.
    Read the request body from the ASGI `receive` channel, call the S1 core, send the response on `send`.
- **Each mount is a THIN wrapper over the S1 core.** It owns ONLY: read raw body + headers from the
  framework request, call the S1 core (passing the injected `DbExecute` — S3 supplies it from config;
  until S3, the mount takes a `DbExecute` parameter), and translate the neutral outcome → the framework's
  HTTP response. NO parsing, NO decompression, NO SQL — all of that is S1. The mount decides nothing about
  the wire.
- **Response mapping.** Neutral accept → 2xx (empty/minimal body); neutral parse error → 4xx. Do NOT
  leak a driver/framework exception to the client — a DB failure surfaces as a neutral 5xx-class outcome
  the mount maps (define the minimal mapping; keep it neutral).
- **Public export posture** replicates the existing middlewares' convention: a lazy `__getattr__`
  re-export from the `receiver/` package `__init__` (its OWN, copied from `integrations/__init__.py:48-61`
  — not shared with it) so a bare import never pulls a framework, and the framework mount module (which
  imports its framework) loads only on name access. Role-named handlers (never a vendor name).
- **The `[fastapi]`/`[django]` extras already exist** (`pyproject.toml:13-14`) — no new extra; the mounts
  ride the existing ones exactly as the middlewares do.

### Out

- The neutral parse/decompress/upsert core — **S1** (S2 wraps it; it does not re-implement any of it).
- Building the `DbExecute` from a `warehouse_dsn` + the receiver config field — **S3** (S2's mounts take
  a `DbExecute`; S3 wires config → driver → mount).
- TS mounts (Express / Next-route / plain-handler) — **S4** (the TS-ecosystem parity half).
- Consumer-side api_key auth enforcement — out (per S1's auth note; the mount does not enforce it this
  cycle).
- Any change to the S1 core, the `events` schema, or the `DbExecute` seam — out (S2 consumes them).

## Acceptance criteria

- [ ] Python Django + FastAPI/ASGI receiver mounts exist, each a thin wrapper over the S1 core,
      mirroring the existing request-context middleware set's structure.
- [ ] Django mount: reads body + headers, calls the S1 core, returns an `HttpResponse` (2xx accept / 4xx
      neutral parse error); Django imported lazily behind `analytics-kit[django]` with a clear neutral
      `RuntimeError` when constructed without the extra — importing the module without Django does not
      error.
- [ ] FastAPI/ASGI mount: the pure-ASGI receiver imports no framework and constructs with no extra
      installed; the FastAPI-specific wiring is gated by `analytics-kit[fastapi]`. It reads the ASGI body,
      calls the S1 core, and sends the response.
- [ ] Each mount does ONLY body/header read + core call + response translation — no parse, decompress, or
      SQL in the mount (those stay in S1).
- [ ] Handlers are re-exported lazily via `__getattr__` (bare import pulls no framework); handler names
      are role-based, never a vendor. Neutrality scan green.
- [ ] Bar B: a consumer adopts by mounting the shipped handler on a route — no library edit, no server
      component authored by the consumer. Bar A: swapping to self-host adds this mount, changes no
      consumer capture/identity/taxonomy code.
- [ ] Tests exercise each mount against a fake request (fake body + headers) and the S1-injectable fake
      `DbExecute`, asserting the core is invoked and the response maps correctly — no real Postgres, no
      real Django/FastAPI server. All Python gates green.

## Technical notes

**Mirror the EXISTING request-context middlewares exactly — this is the INBOUND analog, a port of a
proven pattern, not a new design.** Read these before writing:

- **ASGI middleware** (`python/src/analytics_kit/integrations/asgi.py`) — pure ASGI-3 shape: `__init__`
  stores the wrapped app, `async def __call__(scope, receive, send)`, `http`-scope gating, imports no
  framework. The receiver ASGI mount is the analog: read the request body from `receive` (the `http.request`
  body chunks), call the S1 core, `send` the response. Framework-free construction — the `[fastapi]` extra
  gates the FastAPI-specific convenience wiring, not the ASGI receiver's imports.
- **Django middleware** (`python/src/analytics_kit/integrations/django.py`) — callable-middleware shape,
  lazy `import django` guard (`_DJANGO_AVAILABLE`), clear neutral `RuntimeError` naming
  `analytics-kit[django]` when constructed without the extra, `TYPE_CHECKING` framework types. The Django
  receiver mount follows the same guard/error/lazy-import posture; it is a view/handler, not a
  request-wrapping middleware, but the extra-gating mechanics are identical.
- **Lazy public export** (`python/src/analytics_kit/integrations/__init__.py:48-61`) — `_LAZY_EXPORTS`
  map + `__getattr__` so a bare `import` never pulls a framework. The receiver handlers re-export the same
  way from the `receiver/` package's OWN `__init__` — the convention is COPIED into `receiver/`, the
  `integrations/` package is neither imported nor extended.

**Pre-resolved decisions (locked by the epic Notes):**

- **The LIBRARY ships the receiver; the CONSUMER mounts it.** The receiver is the INBOUND analog of the
  `integrations/` middlewares. REJECTED: a consumer-built receiver / handing the consumer the raw
  `data:[]`/`$`-payload — both force the consumer to write a server component, breaking bar A. — architect
  (2026-07-13)
- **Framework set differs by ecosystem; capability at parity.** Python mounts = Django + FastAPI/ASGI
  (mirroring the existing middleware set). TS mounts = Express / Next-route / plain-handler (S4). The
  framework SET differs by ecosystem — capability is at parity, not framework-for-framework. — architect
  (2026-07-13)

**Body-read caution — the mount owns the framework's body/header read.** The S1 core takes raw
`bytes` + a headers mapping; each framework exposes these differently (Django `request.body` /
`request.headers`; ASGI `receive`-channel `http.request` body chunks + `scope['headers']` byte-tuples).
The mount normalizes the framework's request into (raw bytes, case-insensitive headers) for the core —
that normalization is the mount's ONLY real work beyond the response translation.

**Overlap heads-up (see epic dependency graph):** S2 (Python mounts), S3 (config/DSN wiring), and S4 (TS
mounts) may touch overlapping Python files — S3 adds the receiver config + a from-config mount factory
that wraps THESE mounts, and both S2 and S3 touch the receiver package `__init__`/exports. `/implement-epics`
should run S2 → S3 serially (both edit the Python receiver package surface); S4 is TS-only and can run
independently of S2 (different tree), but after S1.

**Test posture.** Drive each mount with a fake request object (canned body bytes + headers) and the S1
`FakeDbExecute` — assert the core is called with the decoded body/headers and the framework response maps
from the neutral outcome. No real Django/FastAPI server spun up, no real Postgres (the S1 fake seam
covers the write). Mirror how the middleware tests exercise `new_context` without a real request cycle.

> Reviewer suggestion (2026-07-14) → follow-up (seam-level, bundle with the E21 driver-conformance work):
> the mount's `except Exception` around the core call is broad because the `DbExecute` seam raises raw
> driver exceptions unwrapped. Acceptable this slice (scoped to the one `receive()` call, logged, driver
> message proven absent from the response). The clean fix is normalizing driver failures into a neutral
> `DbExecuteError` AT THE SEAM (E17/E18-adjacent) so the mount catches a named type — same seam area as
> E21's Python-driver `fetchall()` write-raise must-fix; do both together when the real driver lands.
> Reviewer note (2026-07-14): `_flatten_headers` is last-wins on a repeated header name — not
> load-bearing (the core reads only single-valued `Content-Encoding`); a conscious assumption for S3/S4.
> Reviewer note (2026-07-14): no FastAPI-specific route factory ships — story-sanctioned (the pure-ASGI
> app IS the FastAPI mount, proven via a real Starlette `Mount` E2E); S3's from-config factory is the
> natural home for a FastAPI convenience wrapper if wanted.

## Shipped

> Captured by `implement-epics` on 2026-07-14.

- **Files added:** `python/src/analytics_kit/receiver/mount.py` (shared `translate`), `django_mount.py`, `asgi_mount.py`, `python/tests/test_receiver_mounts.py` (22 tests)
- **Files changed:** `python/src/analytics_kit/receiver/__init__.py` (lazy `__getattr__` re-export)
- **New public API:** `make_receiver_view(receiver) → Callable[[HttpRequest], HttpResponse]` (Django, behind `[django]`); `ReceiverASGIApp(receiver)` (terminal ASGI-3 app, framework-free) — both lazily re-exported from `analytics_kit.receiver`, role-named
- **Tests added:** 22 — thin-wrapper (core decompresses, mount forwards `Content-Encoding`), Django lazy-`[django]` guard + neutral error, ASGI chunked-body drain + multi-valued-header flatten, 2xx/4xx/5xx mapping with driver-message-absent proof (fake DSN not in body), subprocess `MetaPathFinder` proofs that a bare import pulls no framework + ASGI serves with frameworks blocked, real Starlette `Mount` E2E
- **Commit:** this story's ship commit on `main` (see `git log`)
- **Reviewer notes:** independent gate verdict SHIP (no criticals) — genuinely thin, real (non-vacuous) lazy-import proofs, ASGI headers flattened + chunks drained, driver messages neutralized. 3 forward/non-blocking suggestions above
- **Cross-story seams exposed:** **S3 layers its from-config factory onto the same `receiver/__init__` `_LAZY_EXPORTS` surface** (additive) and composes the DSN→driver→`Receiver`→mount chain. Mounts take an injected `Receiver` (holds the `DbExecute`); the shared `translate` helper (`mount.py`, internal) guarantees byte-identical status mapping across frameworks. **S4** mirrors this for the TS ecosystem (Express/Next/plain-handler). **E21/follow-up:** normalize driver failures into a neutral `DbExecuteError` at the seam alongside the `fetchall()` write-raise fix.
