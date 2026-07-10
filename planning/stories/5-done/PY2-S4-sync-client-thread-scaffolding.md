---
id: PY2-S4-sync-client-thread-scaffolding
epic: PY2-CORE-python-seam
status: ready-for-dev
area: core
touches: [adapters]
depends_on: [PY2-S3-config-factory-and-noop]
api_impact: additive
---

# PY2-S4-sync-client-thread-scaffolding — Sync-client posture + background-thread seam

## Why

The Python client posture is locked as **sync with a background flush thread** (posthog-python's model), NOT asyncio. This story lands only the SEAM SHAPE that PY4's real queue/thread delivery plugs into — the sync `flush`/`shutdown` lifecycle contract and the `sync_mode` inline flag — so PY4 fills a pre-shaped hole rather than inventing the posture. It is the Python-specific analog of the lifecycle seam the TS node target settled; there is no TS "thread" analog (JS is single-threaded event-loop), so this posture is a deliberate Python idiom, grounded in `posthog-python/posthog/consumer.py`.

## Scope

### In

- Establish the **sync-client lifecycle contract** on the provider (in `analytics_kit/provider.py`) delegating to the PY2-S1 adapter contract:
  - `flush() -> None` and `shutdown() -> None` are **synchronous** (block until the delegated `adapter.flush()`/`adapter.shutdown()` drain returns) — the Python analog of TS's `Promise<void>` lifecycle, expressed sync. This pins that the SPI's `flush`/`shutdown` (already declared sync in PY2-S1) are *drain-to-completion* semantics, not fire-and-forget.
  - A `sync_mode: bool` config/flag seam (on `AnalyticsConfig`, added additively) whose contract is: `sync_mode=True` ⇒ delivery is inline (no background thread); `sync_mode=False` (default) ⇒ delivery is offloaded to a background daemon thread. **PY2-S4 defines the flag + the lifecycle contract; PY4 implements the actual queue + thread inside its adapter.**
- Document the posture explicitly in a module docstring: sync client + background daemon thread, NO asyncio, `sync_mode` inline bypass — so PY4 (and any reader) inherits the decision without re-deriving it.
- **The plug-point IS the `AnalyticsAdapter` contract itself (Option A — no separate provider-facing sink).** Under the capture-only SPI (PY2-S1), the provider already hands every minted `NeutralEvent` to `adapter.capture(event)` and drains via `adapter.flush()`/`adapter.shutdown()`. That trio (`capture`/`flush`/`shutdown`) IS the plug-point PY4's queue-backed adapter fills — the `NoopAdapter` satisfies it by dropping, PY4's adapter by enqueueing + draining. Do NOT introduce a second `NeutralEvent`-routing seam (a separate "delivery sink" `callable`/`Protocol`) — it would duplicate `adapter.capture` for zero gain and widen the surface Option A deliberately shrank. S4 adds NO new routing member to the SPI; its concrete deliverables are the `sync_mode` field + the sync-lifecycle contract + the posture docstring.

### Out

- The actual `queue.Queue` + background daemon `Thread` + `atexit` join + drop-oldest overflow + size/interval flush triggers — **all PY4** (`PY4-NODE-server-capture`). PY2-S4 lands only the lifecycle contract + the flag + the plug-point.
- Any wire delivery / batching / retry — PY4.
- An asyncio client — explicitly NOT this cycle (additive future); do not scaffold async.
- The config-selected factory + noop — **PY2-S3** (this story extends `AnalyticsConfig` with `sync_mode` additively).

## Acceptance criteria

- [ ] `flush()` and `shutdown()` on the provider are synchronous (return `None`, block until the delegated drain returns) — no coroutine, no `await`.
- [ ] `AnalyticsConfig` carries `sync_mode: bool = False` (additive to PY2-S3); its documented contract is inline-vs-background-thread delivery.
- [ ] The plug-point PY4 fills is the existing `AnalyticsAdapter.capture`/`flush`/`shutdown` contract (Option A) — the `NoopAdapter` satisfies it by dropping/returning, provably with no threading code present. NO new `NeutralEvent`-routing member is added to the SPI in this story.
- [ ] A module docstring records the LOCKED posture: sync client + background daemon thread, NO asyncio, `sync_mode` inline bypass.
- [ ] No `asyncio`, no `async def`, no `await` anywhere in the seam.
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token in the seam or docstrings; `grep -ri posthog analytics_kit` is clean.

## Technical notes

- **Sync client + background daemon thread; NO asyncio.** — architect (2026-07-09, Cluster 2, high): posthog-python is sync-with-daemon-thread (`consumer.py`), with `sync_mode` for inline. The TS node single-thread model is a JS-runtime artifact, not a contract — the Python posture is a deliberate idiom. Most Python server code is sync (Django/WSGI/scripts/Celery); a thread-backed sync client serves them and works fine called from an ASGI request (send offloaded to the thread, not awaited). An async client is a clean ADDITIVE future, NOT this cycle. Rejected: async-first or dual sync+async — doubles surface + test matrix for no R-parity gain.
- **This story is the SEAM ONLY; PY4 is the delivery.** The queue/thread lives in PY4's server-capture adapter (`queue.Queue` + daemon `Thread`, size-OR-interval flush, drop-oldest at a bounded cap to MATCH TS — NOT posthog-python's drop-newest — `atexit` join, `sync_mode` bypass). PY2-S4 only fixes the lifecycle contract (`flush`/`shutdown` sync), the `sync_mode` flag, and the plug-point the queue attaches to. Do NOT implement threading here — if the builder finds themselves writing `Thread(...)`, that work belongs in PY4.
- **No separate sink — the adapter contract is the plug-point (Option A).** Earlier framing floated an injectable "delivery sink" `callable`/`Protocol`; the Option-A capture-only SPI makes that redundant (the provider already routes every event through `adapter.capture` and drains via `adapter.flush`/`adapter.shutdown`). PY4 hands in its queue-backed behavior by supplying an adapter whose `capture` enqueues and whose `flush`/`shutdown` drain — no new seam member. Keep PY2 the simplest thing that typechecks against the `NoopAdapter`.
- **`sync_mode` semantics** (de-brand from posthog-python `client.py` `sync_mode`): `True` bypasses the thread (inline POST) — the mode used by tests and short-lived scripts; `False` (default) uses the background thread. PY2 defines the flag + contract so PY4 wires the two paths.
- **CONTRACT vs IDIOM reference:** the lifecycle `flush`/`shutdown` CONTRACT ports *to* TS `node-analytics.ts` (its `flush()`/`shutdown()` returning promises → sync here); the thread/`sync_mode` IDIOM de-brands *from* posthog-python `consumer.py`/`client.py`. The posture choice (sync+thread) is the architect's ruling, not a posthog-python copy.
- **Neutrality lesson from PY1 — docstrings ship** vendor-neutral; only `#`-comments carry provenance.
> Reviewer suggestion (2026-07-09): the seam-guard's `_SEAM_MODULES` tuple omits `client.py` (a public seam module re-exporting `Analytics`) — a stray `import threading`/`async def` there would pass the guard silently. Add `"client"` to the tuple.
> Reviewer suggestion (2026-07-09): note (test docstring) that `_FORBIDDEN_IMPORTS` fences the SEAM modules, not the whole package — PY4's delivery adapter legitimately imports `queue`/`threading`/`atexit`.

## Shipped

> Captured by `implement-epics` on 2026-07-09.

- **Files changed:** `python/src/analytics_kit/config.py` (+`sync_mode: bool = False`, additive, known field under `extra="forbid"`), `python/src/analytics_kit/provider.py` (posture docstring + drain-to-completion pins on `flush`/`shutdown`)
- **Files added:** `python/tests/test_sync_seam.py` (11 cases incl. an AST guard proving NO threading/queue/asyncio in the seam)
- **New public API:** `AnalyticsConfig.sync_mode: bool = False` (inline vs background-thread delivery contract)
- **Tests added:** `test_sync_seam.py` — `sync_mode` parse, `flush`/`shutdown` sync drain-to-completion (`iscoroutinefunction` False + delegation-ordering), and the machine-enforced no-delivery AST guard
- **Commit:** `core-cycle` (message = story title)
- **Reviewer notes:** `see Technical notes` — clean/ship; 2 suggestions captured for the improvement pass (widen the AST guard to `client.py`; clarify it fences seam modules not the package)
- **Cross-story seams exposed:** **PY4** fills the pre-shaped hole — the existing `AnalyticsAdapter.capture`/`flush`/`shutdown` trio is the plug-point (Option A, no new SPI member); PY4 owns the `queue.Queue` + daemon `Thread` + `atexit` join + **drop-oldest** overflow (to match TS, NOT posthog-python's drop-newest) + size/interval flush + the `sync_mode` inline-vs-thread paths. The AST guard fences delivery OUT of the seam modules; PY4's adapter is where queue/threading legitimately land.

## Follow-up

> PY2 post-close improvement pass, 2026-07-10.

- **Widened the AST seam-guard to cover `client.py`** — `_SEAM_MODULES` now includes `"client"` (the public re-export module was omitted, so a stray `import threading`/`async def` there would have slipped the fence). Negative-controlled: planting `import threading` in `client.py` fails the guard with the right message; reverted → 12 seam-guard tests pass.
- **Clarified the guard's scope** — a `#`-comment now records that `_FORBIDDEN_IMPORTS` fences the SEAM modules only, not the whole package (PY4's delivery adapter legitimately imports `queue`/`threading`/`atexit`).
- Touched only `python/tests/test_sync_seam.py`; gates green (mypy strict 18 · ruff · pytest 71 · neutrality clean).
