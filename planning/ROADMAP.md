# Roadmap — analytics-kit

Last updated: 2026-07-10 — E12 (feature-flags substrate + remote eval) shipped + archived; E13 (local eval) next

## Status

Pre-1.0. Three cycles complete and archived: the vendor-neutral **`core`** seam and the **R1 targets**
cycle in TypeScript, then **Python parity** — a full, server-shaped Python implementation at capability
parity with the shipped TS surface. Both languages now live under a polyglot [`ts/`](../ts/) +
[`python/`](../python/) layout; both acceptance bars and vendor-neutrality are gated as standing checks
in each tree. The focus now shifts from breadth (a second language) to **depth** — the two
declared-but-unimplemented capability ports, built across both trees. Closed cycles archive their epics
to [`epics/done/`](epics/done/); the narrative of what each established lives in
[`planning/HISTORY.md`](HISTORY.md).

## Sequencing

NOW holds the epics committed for the current build push; **`/implement-epics all` builds every NOW
epic**, in dependency order driven by each epic's `blocked_by` graph. Epics are the unit of work,
not grouped into area-cycles. Prioritization is measured against the SOTA / `posthog-js`-capability
bar, not consumer pull.

## NOW

**Cross-tree capability completion** — build out the two declared-but-unimplemented capability ports
across **both** language trees. Each is already declared on the shipped seam (`FeatureFlagPort` and
`SessionReplayPort` as optional, `None`-default capability slots), so this **finishes stubbed contracts
additively** rather than widening the charter. The neutral interface is defined once and satisfied by
each target's adapter, keeping provider-swap and config-only adoption intact. Prioritized against the
SOTA / `posthog-js`-capability bar.

- **feature-flags** — implement `FeatureFlagPort`: evaluation, bootstrap, local + server-side eval, flag
  payloads. Core cross-platform surface for every mature analytics SDK — in the `posthog-js` reference it
  lives in `core` + `browser` + `node`, so it is inherently server- **and** browser-shaped and advances
  the TS *and* Python surfaces together. **Sequences first** — the broadest surface.
- **session-replay** — implement `SessionReplayPort`: DOM capture. **Browser-shaped, TS-only in practice**
  (no server analog), so it advances a narrower slice and **sequences after** feature-flags.

### Epics

**feature-flags** (sequences first — broadest surface, both trees):

- **[E12-FF-flag-substrate-remote-eval](epics/done/E12-FF-flag-substrate-remote-eval.md)** *(done)* — the neutral
  `FeatureFlagPort` (async-first snapshot model, with a neutral `degraded`/`reason` signal so eval
  failure is distinguishable from a real "off") + `FlagContext` + taxonomy `flags` slot +
  config-supplied bootstrap + **remote-evaluation** adapters (browser fetch, node round-trip, Python
  server) across both trees + the React flag hook. `blocked_by: []`.
- **[E13-FF-local-eval](epics/E13-FF-local-eval.md)** — **local (in-process) evaluation**, the
  server-shaped specialization (definition polling + `matchProperty` cohort/rollout eval + fallback),
  TS-node + Python, **zero seam change** — the regression check that E12's port shape holds.
  `blocked_by: [E12]`.

**session-replay** (sequences after — narrower, browser-only, TS):

- **[E14-SR-session-replay](epics/E14-SR-session-replay.md)** — the neutral `SessionReplayPort`
  (`start`/`stop`/`isActive`/`getReplayId`) + config-only adoption (sampling + privacy masking) +
  rrweb-behind-the-adapter recorder (separate entrypoint) + capture-side session/event linkage
  (re-key on rotation) + own snapshot delivery path (size-triggered flush, flush-on-teardown, a
  sampling flush-guard). **Python: N-A-BY-PLATFORM** (slot permanently `None` — a final documented
  boundary). `blocked_by: []`.

**Dependency graph:** `E12 → E13` (E13 needs E12's shipped port); `E14` is independent. A valid build
order: **E12 → E13 → E14** (sequence flags before replay per the NOW framing; E14 could run in parallel
with E13 but is scheduled after for a clean per-area push).

**Exit criteria (cycle closes when all hold):** both ports finished additively on the seam with zero
frozen-`AnalyticsProvider`-pin disturbance; **bar A** (provider-swap = one adapter, zero consumer
change) and **bar B** (new-app = config only, zero library change) re-proven for flags (both trees) and
replay (TS); parity matrix updated — feature-flags present in both trees (local eval server-shaped,
browser-absent-by-platform), session-replay N-A-BY-PLATFORM on Python (final, not pending); the standing
neutrality + gate suite green in both trees.

## Development prerequisites

External setup Claude Code cannot reach — gates the integration/real-stack proof of the epic noted,
not its unit work.

- **E13 (local eval)** — a live analytics project + a **privileged (definition-reading) API key** to
  ground-truth local-eval results against a real remote eval (the PY8 lesson: the real path, not a
  self-consistent mock). Unit-level rule-matching tests need no key.
- **E14 (session replay)** — a live analytics project + an **ingest key that accepts session-recording
  (`$snapshot`) payloads** to prove replay snapshots deliver end-to-end. Unit-level recorder/masking/
  linkage tests need no key.

## UPCOMING

_Empty — all committed forward work is in **NOW** (feature-flags + session-replay). New areas land here
first, via `/roadmap add-later` → promote, once the NOW push is scoped._

## LATER

_Empty._

## Cycle history

| Shipped | Closed | Epics |
|---|---|---|
| `core` seam | 2026-07-08 | E1, E2, E3 → [`epics/done/`](epics/done/) |
| `R1 targets` + audit | 2026-07-09 | E4, E5, E6, E7, E8, E9, E10, E11 → [`epics/done/`](epics/done/) |
| `Python parity` | 2026-07-10 | PY1, PY2, PY3, PY4, PY5, PY6, PY7, PY8 → [`epics/done/`](epics/done/) |

## How to read this file

- **This file is forward-looking — it lists only epics still to build.** A done epic is never left
  here: on close it archives to [`epics/done/`](epics/done/), gets one row in **Cycle history**
  above, and its narrative moves to [`planning/HISTORY.md`](HISTORY.md).
- **NOW** holds every epic committed for the current build push; `/implement-epics all` builds them
  in `blocked_by` dependency order. **UPCOMING / LATER** hold epics not yet committed to a build
  push.
- **Epics are the unit of work.** No version numbers appear here — versions are git tags, not
  planning labels. Epic links point to `epics/<id>.md` (closed epics live under `epics/done/`);
  stories live under `stories/1-backlog/ … 5-done/`.
- **Promotion** (NOW↔UPCOMING↔LATER) and re-sequencing are user-driven via `/roadmap`; per-epic
  execution runs through `/implement-epics`.
