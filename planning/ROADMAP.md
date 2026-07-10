# Roadmap — analytics-kit

Last updated: 2026-07-09 — R1 targets closed; repo split into `ts/` + `python/`; Python parity is UPCOMING

## Status

Pre-1.0. Two cycles complete in **TypeScript**: the vendor-neutral **`core`** seam, then the **R1
targets** cycle (browser · node · React targets + example consumer + adoption audit) — the TS lib is
capability-complete against the BRIEF contract, with both acceptance bars and vendor-neutrality gated
as standing CI checks. On 2026-07-09 the repo split into a polyglot layout ([`ts/`](../ts/) shipped,
[`python/`](../python/) scaffolded); the committed next cycle is **Python parity** (see UPCOMING).
**NOW is empty — awaiting `/roadmap promote`** to open it (user-driven). Closed cycles archive their
epics to [`epics/done/`](epics/done/); the narrative of what each established lives in
[`planning/HISTORY.md`](HISTORY.md).

## Sequencing

NOW holds the epics committed for the current build push; **`/implement-epics all` builds every NOW
epic**, in dependency order driven by each epic's `blocked_by` graph. Epics are the unit of work,
not grouped into area-cycles. Prioritization is measured against the SOTA / `posthog-js`-capability
bar, not consumer pull.

## NOW

_Empty — both shipped TS cycles are complete and archived. Run `/roadmap promote` to open the next
cycle (Python parity — see UPCOMING)._

## UPCOMING

**Python parity** — a full Python implementation of the vendor-neutral library under
[`python/`](../python/) (scaffolded), at capability parity with the shipped TS lib: **every
capability the TS surface exposes, reachable in Python**, adapted idiomatically (server-shaped — a
plain client + framework bindings; no browser/DOM target). Same seam — provider contract, adapter
`Protocol`, typed taxonomy, consumer-supplied allowlist, config-selected factory — de-branded from
`posthog-python`, with a Python analog of the neutrality scan. Epics are drafted at `/roadmap
promote` (architect-consulted); the shape mirrors the TS build (seam → server capture → query →
framework bindings → example → audit).

> **Development prerequisite** (attach at promote time): clone `posthog-python`
> (PostHog/posthog-python) beside `posthog-js/` at the repo root — the Python de-branding reference.

## LATER

- **feature-flags** — implement the declared-but-unimplemented `FeatureFlagPort` (eval / bootstrap /
  local eval / payloads) across the targets. Applies to both languages.
- **session-replay** — implement the declared-but-unimplemented `SessionReplayPort`. Browser-shaped;
  TS-only in practice.

## Cycle history

| Shipped | Closed | Epics |
|---|---|---|
| `core` seam | 2026-07-08 | E1, E2, E3 → [`epics/done/`](epics/done/) |
| `R1 targets` + audit | 2026-07-09 | E4, E5, E6, E7, E8, E9, E10, E11 → [`epics/done/`](epics/done/) |

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
