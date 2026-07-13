# Roadmap — analytics-kit

Last updated: 2026-07-13 — capability-completion + query-row-contract cycles retired to history; NOW/UPCOMING/LATER cleared, awaiting next focus area

## Status

Pre-1.0. **Five cycles complete and archived**: the vendor-neutral **`core`** seam, the **R1 targets**
cycle, **Python parity**, **capability completion** (feature-flags + session-replay), and the
**query row contract** cross-tree work. Both language trees live under a polyglot [`ts/`](../ts/) +
[`python/`](../python/) layout and are at capability + read-contract parity; both acceptance bars and
vendor-neutrality are gated as standing checks in each tree. **No cycle is currently in flight** — the
next focus area is user-driven. Closed cycles archive their epics to [`epics/done/`](epics/done/); the
narrative of what each established lives in [`planning/HISTORY.md`](HISTORY.md).

## Sequencing

NOW holds the epics committed for the current build push; **`/implement-epics all` builds every NOW
epic**, in dependency order driven by each epic's `blocked_by` graph. Epics are the unit of work,
not grouped into area-cycles. Prioritization is measured against the SOTA / `posthog-js`-capability
bar, not consumer pull.

## NOW

_No cycle in flight._ The last cycle (`query row contract`) is closed and archived; nothing is queued to
become the next focus. The **next focus area is user-driven** — name the next NOW area directly, or
`/roadmap add-later <area>` → promote. Do not assume a next area; nothing is committed.

## UPCOMING

_Empty._

## LATER

_Empty._

## Cycle history

| Shipped | Closed | Epics |
|---|---|---|
| `core` seam | 2026-07-08 | E1, E2, E3 → [`epics/done/`](epics/done/) |
| `R1 targets` + audit | 2026-07-09 | E4, E5, E6, E7, E8, E9, E10, E11 → [`epics/done/`](epics/done/) |
| `Python parity` | 2026-07-10 | PY1, PY2, PY3, PY4, PY5, PY6, PY7, PY8 → [`epics/done/`](epics/done/) |
| `capability completion` | 2026-07-10 | E12, E13, E14 → [`epics/done/`](epics/done/) |
| `query row contract` | 2026-07-13 | E15, E16 → [`epics/done/`](epics/done/) |

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
