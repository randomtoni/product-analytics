---
id: PY8-S3-real-stack-probes-and-bar-proofs
epic: PY8-OBS-parity-audit
status: ready-for-dev
area: observability
touches: [core, node, privacy]
depends_on: [PY8-S2-neutrality-scan-analog]
api_impact: additive
---

# PY8-S3-real-stack-probes-and-bar-proofs — Real-stack probes + negative controls + re-runnable bar-A/bar-B proofs

## Why

Bakes in the load-bearing R1 lesson — **"all gates green ≠ correct"**: the audit must include
**real-stack probes** (a real capture round-trips over a real socket; a real query returns a real
shape) + **negative controls** (an off-list key is actually rejected on the wire; an unkeyed client
actually sends nothing; a `dedupe_id` retry is actually idempotent) — NOT just self-consistent unit
tests — plus **both acceptance bars re-proven** as re-runnable gated proofs. It is the Python
realization of TS `E11-S3` (bar A) + `E11-S4` (bar B) hardened with the real-stack + ground-truthing
discipline. This closes the epic and the Python-parity cycle.

## Scope

### In

- **Real-stack capture probe** (a `pytest` test, in `python/tests/`): a real capture round-trips over
  a **local loopback HTTP server** (a stdlib `http.server` on an ephemeral port) that captures the
  actual POSTed wire bytes. The probe MUST route through the REAL send path —
  `create_send_batch(config, UrllibTransport())` wired as a `BatchConsumer` sink, `sync_mode=True` (or
  drive `flush()`) for deterministic inline delivery — **NOT the default `_BufferSink`** (which never
  touches the transport) and **NOT an injected fake `Transport`** (a mock, not a real-stack proof). It
  asserts on the bytes the loopback server received (decompress `Content-Encoding: gzip`, then
  `json.loads`):
  - **Path** = the configured `ingest_path`, default `/batch/`; **method** = `POST`; headers carry
    `Content-Type: application/json` and `Content-Encoding: gzip` when gzipped.
  - **Envelope top-level keys** = exactly `{api_key, batch, sent_at}` — `api_key` equals the configured
    key, `batch` is a list, `sent_at` is an ISO-8601 string.
  - **Per-event keys** in `batch[i]` = `uuid`, `event`, `distinct_id`, and `properties`/`timestamp` when
    present. The **idempotency field is `uuid`**, equal to the neutral `dedupe_id` verbatim — NOT
    `$insert_id`.
  - **Neutrality on the real bytes** (the R1-specific proof): the captured body carries **zero
    `$`-prefixed keys** and **zero `posthog`/vendor tokens**; trait/group events surface the de-branded
    nested wrappers (`set`/`set_once`/`group_type`/`group_key`/`group_set`), never `$set`/`$groupidentify`.
- **Real-shape query probe**: point the query client's HTTP endpoint at a loopback server returning a
  canned real-shaped response body; assert the client decodes it into the neutral `QueryResult`/
  `QueryColumn` shape (the ONE genuine inbound-wire boundary — Pydantic-validated). The query client's
  endpoint IS config-supplied (`QueryClientConfig.query_endpoint`, mirrors the TS `HttpQueryAdapter`) — a
  loopback drops in, no live warehouse needed; the handler must serve the composed path
  `/api/projects/<project_id>/query/` (see Technical notes for the exact URL/auth/envelope shape).
- **Negative controls**, each realized against the same real loopback transport (NOT a mock):
  1. **Off-list key rejected → ABSENT from the captured body.** Configure a consumer allowlist; capture
     an event carrying an off-list property; drive delivery; assert the off-list key is **not present
     anywhere** in the decompressed `batch[i].properties` the server received (while an on-list key IS
     present). Proves the allowlist enforces at/before the wire.
  2. **Unkeyed client sends NOTHING → ZERO requests hit the server.** Construct the client unkeyed
     (the no-op/`NoopAdapter` posture), drive the same capture sequence + `flush()`, assert the loopback
     server's received-request count is **exactly 0** (the socket was never touched). The Python analog
     of E11-S3 test #4 (the Noop-backed run records nothing, difference behind the seam).
  3. **Dedupe/idempotency retry → `uuid` STABLE across a retry.** Capture an event with a fixed
     `dedupe_id`; have the loopback server return a transient status (`429`/`503`) on the first hit and
     `200` on the second, driving the transport's real retry machinery (`send_with_retry`, with an
     injectable `wait` so the test doesn't sleep); assert the `uuid` in BOTH captured requests is
     identical. Proves idempotency is real (a retry re-sends the same dedup key).
- **Ground-truthing vs `posthog-python` = a SOURCE comparison, not a live call.** The probe's assertions
  cite the `posthog-python/` source contract for WHY each expected value is correct (`/batch/` path,
  top-level `uuid`, `{api_key, batch, sent_at}` envelope), and the de-brand assertions (`$`-free,
  vendor-free, `uuid` not `$insert_id`) cite where `posthog-python` DIVERGES and why the neutral surface
  must not follow. No live vendor endpoint.
- **Bar-A re-proof** (re-runnable gated, mirroring TS `E11-S3`): the SAME `create_analytics(config, adapter=...)`
  call site flows a `NoopAdapter` ↔ a `RecordingAdapter` (or the loopback-backed `ServerAdapter`) with
  the provider facade byte-identical (the difference lives entirely behind the seam) — provider-swap =
  one adapter, zero consumer change — PLUS a short on-paper second-adapter design over the real
  `AnalyticsAdapter` SPI (the 8-member structural Protocol in `adapter.py:32-81`).
- **Bar-B re-proof**: point at / re-run the PY7 Quillstream two-gate proof (fidelity = installed-dist
  `mypy`; enforcement = the AST import-audit with the five-entry public allow-list). **Reuse PY7's
  gates, do not reinvent** — the story references them as the standing bar-B proof, and confirms the
  changeset for THIS story touches only `python/tests/**` + `python/scripts/**` (the audit adds probes;
  it does not edit `analytics_kit`, per audit-not-patch).

### Out

- The parity matrix + README docs — **PY8-S1**.
- The neutrality-scan analog — **PY8-S2** (this story does not re-implement it; the neutrality-on-the-wire
  assertions here are a COMPLEMENT — static scan proves the source/artifacts are clean, the probe proves
  the emitted BYTES are clean).
- **Fixing** anything a probe surfaces — a failing probe is a bug against the owning epic (audit-not-patch),
  NOT an example/library patch inside this story.
- A live vendor endpoint / API key — explicitly NOT required (architect ruling below). No
  `## Development prerequisites` gate, no `blocked_by`.
- A CI pipeline — the probes run locally via `uv run pytest`; CI-wiring is later infra.

## Acceptance criteria

- [ ] The capture probe drives the REAL send path (`create_send_batch` → `UrllibTransport` → a real
      loopback socket), NOT the default `_BufferSink` and NOT a fake `Transport`, and asserts on the
      bytes a real localhost server received.
- [ ] The captured envelope has top-level keys exactly `{api_key, batch, sent_at}`; `api_key` = the
      configured key; each `batch[i]` carries `uuid` (= `dedupe_id` verbatim, NOT `$insert_id`), `event`,
      `distinct_id`; path = `/batch/` (or the configured `ingest_path`); method `POST`; gzip header
      present when gzipped.
- [ ] The captured body carries **zero `$`-prefixed keys** and **zero `posthog`/vendor tokens**;
      trait/group events surface the de-branded `set`/`set_once`/`group_type`/`group_key`/`group_set`
      wrappers, never `$set`/`$groupidentify`.
- [ ] The query probe decodes a canned real-shaped loopback response into the neutral `QueryResult`
      shape via the config-supplied query endpoint.
- [ ] Negative control 1: an off-list key is ABSENT from the captured wire body (an on-list key is
      present).
- [ ] Negative control 2: an unkeyed client produces EXACTLY ZERO requests at the loopback server.
- [ ] Negative control 3: a retry (loopback returns `429`/`503` then `200`) re-sends an IDENTICAL `uuid`
      across both captured requests, driven through the real `send_with_retry` path (injected `wait`, no
      real sleep).
- [ ] Each probe/control cites the `posthog-python/` source location grounding the expected wire value
      (path / envelope / `uuid`), and the de-brand assertions cite where `posthog-python` diverges — a
      SOURCE comparison, no live call.
- [ ] Bar A: a re-runnable gated test flows `NoopAdapter` ↔ recording/loopback adapter through the same
      `create_analytics(config, adapter=...)` call site with a byte-identical provider facade; paired with
      an on-paper second-adapter design over the real `AnalyticsAdapter` Protocol.
- [ ] Bar B: the PY7 Quillstream two-gate proof (installed-dist mypy + AST import-audit, five-entry public
      allow-list) is referenced as the standing bar-B proof; this story's changeset touches only
      `python/tests/**` + `python/scripts/**`, zero `analytics_kit` edits (audit-not-patch, verifiable by
      diff).
- [ ] `uv run pytest` + `uv run ruff check` + `uv run mypy` stay green; the probes run with ZERO external
      setup (loopback only; no live endpoint, no secrets).

## Technical notes

- **ARCHITECT RULING (2026-07-10) — the local-loopback captured-request server IS a real-stack probe;
  no live endpoint needed.** I spawned the `architect` agent on the load-bearing open question (does a
  local loopback server satisfy "real-stack probe + negative control" without gating on a live vendor
  endpoint?). Verdict: **yes — local-loopback is correct AND sufficient; do NOT add a
  `## Development prerequisites` / `blocked_by` gate for a live endpoint; introducing one would WEAKEN the
  audit** (non-deterministic, flaky, needs secrets) and violate the standing "never hit a real backend"
  convention. Grounded against the E11 TS precedent, the shipped Python transport, and the posthog-python
  wire contract read from source. Key mechanics the ruling pinned:
  - The probe must route through `create_send_batch(config, UrllibTransport())` as a `BatchConsumer` sink
    (`sync_mode=True` or drive `flush()`), NOT the default `_BufferSink` (`server/adapter.py:41` — it just
    appends to a list, never touches the transport) and NOT an injected fake `Transport` (a mock, not a
    real-stack proof). `create_send_batch` (`server/transport.py:109`) resolves the endpoint from
    `config.ingest_host + config.ingest_path` (`resolve_endpoint`, `server/transport.py:102`) — point
    `ingest_host` at `http://127.0.0.1:<port>` and the default `UrllibTransport` (`server/transport.py:80`)
    opens a real socket via `urllib.request.urlopen`. A stdlib `http.server.BaseHTTPRequestHandler` on an ephemeral port (per-test
    `pytest` fixture, zero new dependency) is the Python analog of E11's loopback capture server.
  - **Wire ground-truth (posthog-python source, verified by architect):** envelope `{api_key, batch,
    sent_at}` POSTed to `/batch/` — `posthog-python/posthog/request.py:224-231, 364`; per-event message
    top-level `event`/`distinct_id`/`properties`/`timestamp`/`uuid` — `posthog-python/posthog/client.py:1043-1047`;
    gzip + `Content-Type`/`Content-Encoding` headers — `request.py:233-242`. Our emitter mirrors this
    (`server/wire_mapper.py`: `assemble_batch_envelope` → `{api_key, batch, sent_at}`; `map_event_to_wire`
    → top-level `uuid` from `dedupe_id`), MINUS the `$`-prefixed vendor special-event names
    (`$set`/`$groupidentify`) which our surface neutralizes to `set`/`group_*` nested wrappers. That
    divergence IS the neutrality proof — assert `$`-free / vendor-free bytes.
  - Each negative control's realization (off-list key ABSENT from captured body; unkeyed → ZERO requests;
    retry → stable `uuid` via loopback `429`/`503`-then-`200` driving `send_with_retry` with an injected
    `wait`) is spelled out in Scope.In above, verbatim from the ruling.
  - **The `posthog-python/` reference checkout at the repo root** (a read-only source checkout, already a
    named Python-cycle dev prerequisite in `CLAUDE.md`) is the ONLY prerequisite — for source
    ground-truthing, NOT a live service. It is NOT a `blocked_by`.
- **Route through the production target-entry, not a hand-wired consumer (pin).** The real send path in
  production is `create_server_analytics(config)` (`server/__init__.py:32-58`): when `config.key` is set it
  builds `BatchConsumer(create_send_batch(config, UrllibTransport()), sync_mode=config.sync_mode, …)` and
  injects it as the `ServerAdapter`'s `sink`. The probe should drive THIS entry point — construct the
  keyed config with `ingest_host="http://127.0.0.1:<port>"`, `sync_mode=True`, and `key=<test-key>`, then
  `create_server_analytics(config)` — so the probe exercises the exact composition production ships,
  rather than re-assembling `BatchConsumer(create_send_batch(...))` by hand (which risks drifting from the
  real wiring and hollowing the proof). The `_BufferSink` default is what you get from a bare
  `ServerAdapter()` with NO sink injected — `create_server_analytics` never uses it for a keyed config, so
  routing through `create_server_analytics` is precisely how you avoid the `_BufferSink` trap by
  construction. (Unkeyed config → `create_analytics(parsed)` → the whole-stack `NoopAdapter`: that IS
  negative control #2's construction — zero requests.)
- **Honesty of the proof (E11 discipline).** The whole point of the real-stack probe is that it pins the
  emitted bytes against an EXTERNAL contract (posthog-python source) + the neutrality invariant — neither
  of which the code-under-test can satisfy by accident. State the "real send path, not `_BufferSink`, not
  a fake Transport" requirement in the AC the way E11 stated "reviewer INDEPENDENTLY planted a real token"
  — the proof goes hollow if it exercises anything but the real socket.
- **Bar-B carry-in (from PY7).** The bar-B enforcement mechanism to reference is PY7's AST import-audit
  with the **five-entry public allow-list** `{analytics_kit, analytics_kit.integrations, analytics_kit.query,
  analytics_kit.server, analytics_kit.taxonomy}` + the fidelity gate (installed-dist `mypy`). Point at /
  reuse the Quillstream gates (`python/examples/quillstream/tests/test_bar_b_import_audit.py` + the
  README two-gate note) — do NOT reinvent them. Python has no physical `dist` boundary, so bar-B is the
  two-gate model (fidelity + enforcement), not TS Fernly's single typecheck-against-`dist`.
- **Bar-A SPI shape.** The real `AnalyticsAdapter` Protocol (`adapter.py:32-81`) is an **8-member**
  structural Protocol: `capture`, `flush`, `shutdown`, `send`, `get_consent_state`, `set_consent_state`,
  `get_library_id`, `get_library_version` (all 8 are methods — there are no non-method members) — read it
  before writing the on-paper second-adapter design so the member count/shape is exact (TS E11-S3 corrected
  a draft's wrong count; count from the real file, don't guess — verified 8 methods at `adapter.py:40-81`).
- **Query-endpoint config check (CONFIRMED config-pointable — a loopback drops in).** Verified against
  `query/http_adapter.py` + `query/config.py`: `QueryClientConfig.query_endpoint` is the config-supplied
  host and `HttpQueryAdapter.__init__` composes the request URL as `query_endpoint + _query_path(project_id)`
  where `_query_path` = `/api/projects/{project_id}/query/` (`http_adapter.py:125-126, 308-309`). So a
  loopback drops in by pointing `query_endpoint` at `http://127.0.0.1:<port>` — but the loopback handler
  must respond on the composed path `/api/projects/<project_id>/query/` (POST), NOT the bare root, and the
  canned response body must carry a result-bearing envelope the normalizer accepts (`results` list, and
  `columns`/`types` when zipping cell-arrays — see `_normalize_result`, `http_adapter.py:240`). Auth is
  `Authorization: Bearer <personal_key>`; the request posture is always-async (`refresh: "async"`), so the
  simplest canned response is an IMMEDIATE result envelope (no `query_status`), which takes the inline
  branch and skips the poll loop. This is config-pointable as the parity rule requires — no seam finding.
- **Audit-not-patch (locked, carried from E11).** This story SURFACES; it does not fix. A failing probe or
  a seam finding routes to the owning epic as a bug — the audit documents and gates, never patches the
  library. This story's changeset is `python/tests/**` + `python/scripts/**` only.
- **CONTRACT reference (port TO):** TS `E11-S3` (`planning/stories/5-done/E11-S3-bar-a-adapter-swap-audit.md`)
  — the gated `NoopAdapter`↔`RecordingAdapter` swap + facade-`keyof`-byte-identical + on-paper 2nd-adapter
  design; TS `E11-S4` (`E11-S4-bar-b-and-capability-completeness.md`) — the config-only footprint gate;
  and the E11 loopback-real-stack precedent. Server-shaped: the loopback HTTP capture server is the Python
  analog of the TS captured-request proof.

> Reviewer note (2026-07-10): CLEAN on first review — no critical, no blocking suggestions. Reviewer mutation-probed 11 assertions (every one BITES for the right reason: mutating `_WIRE_UUID_KEY`→`$insert_id`, `set`→`$set`, neutering `enforce_allowlist`, removing the unkeyed short-circuit (→ 3 requests), disabling retry (→ 1 request), corrupting the query path template — each fails the corresponding test) and verified every posthog-python citation against source. Two non-blocking observations, both "leave as-is": (a) NC1's second on-list-only-capture assertion (`b"pii@example.com" not in …`) is belt-and-suspenders (redundant since drop-and-error-log already dropped the whole event, not vacuous/wrong — leave it); (b) the inline posthog-python citation comments are the load-bearing audit evidence the story requires (source ground-truthing), correctly in test files only (dev-only, never `analytics_kit`/`dist`), citations verified accurate — keep them. No action needed.

## Shipped

> Captured by `implement-epics` on 2026-07-10.

- **Files added:** `python/tests/test_real_stack_capture_probe.py` (real-socket capture probe + neutrality-on-the-wire + the 3 negative controls), `python/tests/test_real_stack_query_probe.py` (real-socket query-shape probe), `python/tests/test_bar_proofs.py` (bar-A gated swap + 8-member on-paper SPI design; bar-B PY7-reuse pointer)
- **Files changed:** none
- **New public API:** none — audit tests only (`python/tests/**`)
- **Tests added:** 19 probes. Capture: real send path via `create_server_analytics(keyed, sync_mode=True, ingest_host=127.0.0.1:<port>)` → real `UrllibTransport` → `urllib.request.urlopen` → stdlib `http.server` loopback; asserts on decompressed received bytes (envelope `{api_key, batch, sent_at}`, per-event `uuid`=`dedupe_id` verbatim not `$insert_id`, `$`-free + vendor-free body via recursive scan, de-branded `set`/`set_once`/`group_*` wrappers). Negative controls: off-list key ABSENT from the wire, unkeyed → EXACTLY 0 requests, retry (503-then-200 driving real `send_with_retry`, injected no-sleep `wait`) → STABLE `uuid`. Query: real `HttpQueryAdapter`+`_UrllibQueryTransport` loopback on the composed `/api/projects/<id>/query/` path w/ Bearer → decode to neutral `QueryResult`. Bar-A: `NoopAdapter`↔`RecordingAdapter` through one `create_analytics(config, adapter=...)` call site, byte-identical facade (asserts 6 real verbs present, cross-checked live), on-paper 8-member SPI design asserted against `dir(AnalyticsAdapter)`. Bar-B: points at `examples/quillstream/tests/test_bar_b_import_audit.py` + the five-entry allow-list.
- **Commit:** `core-cycle` (message = story title)
- **Reviewer notes:** ship-ready, no critical, first review. See Reviewer note above (11 mutation-probes, all bite; posthog-python citations verified accurate against source; audit-not-patch holds — zero `analytics_kit` src edits by diff). Complements PY8-S2: the static scan proves source/artifacts clean, these probes prove the emitted BYTES are `$`-free/vendor-free.
- **Cross-story seams exposed:** PY8 is COMPLETE — S1 (parity matrix + interface→impl + adopt docs) → S2 (the neutrality-scan analog, standing gate) → S3 (real-stack probes + negative controls + bar-A/bar-B re-proofs). The R1 "all-gates-green ≠ correct" discipline is now baked into the Python audit as re-runnable proofs. This CLOSES the Python-parity cycle (PY1–PY8): the Python lib is at capability parity with the shipped TS surface, both acceptance bars re-proven, vendor-neutrality gated (source + artifact + wire).
