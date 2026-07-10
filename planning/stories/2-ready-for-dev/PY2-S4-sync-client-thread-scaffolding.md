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

- Establish the **sync-client lifecycle seam** on the provider/adapter boundary (in `analytics_kit/provider.py` + the adapter contract from PY2-S1):
  - `flush() -> None` and `shutdown() -> None` are **synchronous** (block until the delegated drain returns) — the Python analog of TS's `Promise<void>` lifecycle, expressed sync.
  - A `sync_mode: bool` config/flag seam (on `AnalyticsConfig`, added additively) whose contract is: `sync_mode=True` ⇒ delivery is inline (no background thread); `sync_mode=False` (default) ⇒ delivery is offloaded to a background daemon thread. **PY2-S4 defines the flag + the lifecycle contract; PY4 implements the actual queue + thread.**
  - A minimal, injectable "delivery sink" seam the provider hands minted `NeutralEvent`s to — a callable/`Protocol` the `NoopAdapter` satisfies trivially (drops) and PY4's real adapter satisfies with the `queue.Queue` + daemon `Thread`. This is the plug-point; no real threading here.
- Document the posture explicitly in a module docstring: sync client + background daemon thread, NO asyncio, `sync_mode` inline bypass — so PY4 (and any reader) inherits the decision without re-deriving it.

### Out

- The actual `queue.Queue` + background daemon `Thread` + `atexit` join + drop-oldest overflow + size/interval flush triggers — **all PY4** (`PY4-NODE-server-capture`). PY2-S4 lands only the lifecycle contract + the flag + the plug-point.
- Any wire delivery / batching / retry — PY4.
- An asyncio client — explicitly NOT this cycle (additive future); do not scaffold async.
- The config-selected factory + noop — **PY2-S3** (this story extends `AnalyticsConfig` with `sync_mode` additively).

## Acceptance criteria

- [ ] `flush()` and `shutdown()` on the provider are synchronous (return `None`, block until the delegated drain returns) — no coroutine, no `await`.
- [ ] `AnalyticsConfig` carries `sync_mode: bool = False` (additive to PY2-S3); its documented contract is inline-vs-background-thread delivery.
- [ ] A delivery-sink plug-point exists that the `NoopAdapter` satisfies (drops silently) and that PY4's real adapter will satisfy with a queue+thread — proven by the seam typechecking against the noop with no threading code present.
- [ ] A module docstring records the LOCKED posture: sync client + background daemon thread, NO asyncio, `sync_mode` inline bypass.
- [ ] No `asyncio`, no `async def`, no `await` anywhere in the seam.
- [ ] `uv run mypy` (strict), `uv run ruff check`, `uv run pytest` all exit 0.
- [ ] Zero vendor token in the seam or docstrings; `grep -ri posthog analytics_kit` is clean.

## Technical notes

- **Sync client + background daemon thread; NO asyncio.** — architect (2026-07-09, Cluster 2, high): posthog-python is sync-with-daemon-thread (`consumer.py`), with `sync_mode` for inline. The TS node single-thread model is a JS-runtime artifact, not a contract — the Python posture is a deliberate idiom. Most Python server code is sync (Django/WSGI/scripts/Celery); a thread-backed sync client serves them and works fine called from an ASGI request (send offloaded to the thread, not awaited). An async client is a clean ADDITIVE future, NOT this cycle. Rejected: async-first or dual sync+async — doubles surface + test matrix for no R-parity gain.
- **This story is the SEAM ONLY; PY4 is the delivery.** The queue/thread lives in PY4's server-capture adapter (`queue.Queue` + daemon `Thread`, size-OR-interval flush, drop-oldest at a bounded cap to MATCH TS — NOT posthog-python's drop-newest — `atexit` join, `sync_mode` bypass). PY2-S4 only fixes the lifecycle contract (`flush`/`shutdown` sync), the `sync_mode` flag, and the plug-point the queue attaches to. Do NOT implement threading here — if the builder finds themselves writing `Thread(...)`, that work belongs in PY4.
- **Delivery-sink plug-point shape is a sketch** (mirrors TS `E2`'s "adapter-arg is a sketch, not frozen"): the smallest seam that lets PY4 hand in its queue-backed sink and the `NoopAdapter` hand in a drop. Refine the exact signature when PY4 supplies the real sink; keep PY2's version the simplest thing that typechecks against the noop.
- **`sync_mode` semantics** (de-brand from posthog-python `client.py` `sync_mode`): `True` bypasses the thread (inline POST) — the mode used by tests and short-lived scripts; `False` (default) uses the background thread. PY2 defines the flag + contract so PY4 wires the two paths.
- **CONTRACT vs IDIOM reference:** the lifecycle `flush`/`shutdown` CONTRACT ports *to* TS `node-analytics.ts` (its `flush()`/`shutdown()` returning promises → sync here); the thread/`sync_mode` IDIOM de-brands *from* posthog-python `consumer.py`/`client.py`. The posture choice (sync+thread) is the architect's ruling, not a posthog-python copy.
- **Neutrality lesson from PY1 — docstrings ship** vendor-neutral; only `#`-comments carry provenance.

## Shipped

<!-- Captured by implement-epics on close. -->
