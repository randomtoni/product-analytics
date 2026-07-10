# Roadmap — analytics-kit

Last updated: 2026-07-10 — Python-parity cycle closed + archived to HISTORY; feature-flags + session-replay pulled into NOW (epics not yet drafted)

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

**Epics: not yet drafted.** `/roadmap promote` (or a direct PM dispatch) drafts each area's epics —
architect-consulted against the `posthog-js` reference for load-bearing shape — before
`/implement-epics all` builds them in `blocked_by` dependency order.

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
