---
id: E<n>-<AREA>-<slug>
status: planned
area: <canonical-area-slug>
touches: []
api_impact: additive
blocked_by: []
updated: 2026-07-07
---

# E<n>-<AREA>-<slug> — <Epic title>

<!--
Frontmatter contract (read by /implement-epics + /roadmap — keep these exact):
  id          E<n>-<AREA>-<slug>; <AREA> is the canonical-area CODE and MUST match `area:`.
  status      planned | active | done. /implement-epics flips planned→active on start, active→done on close.
  area        one of the 12 canonical area slugs (core, capture, identify, feature-flags,
              session-replay, privacy, browser, node, react, adapters, query, observability).
  touches     other affected area slugs; [] if single-area.
  api_impact  additive | behavior | breaking. Grounds the cycle-close version bump.
  blocked_by  [] normally; an open external prerequisite or a blocking epic id gates building.
              /implement-epics `all` skips an epic with an open gate.
  updated     YYYY-MM-DD; bumped on every status change.
-->

## Why

<1-3 sentences: the downstream need this serves and why it is the highest-leverage thing now. Cite `research/<file>.md` if it informs this epic. Research → epic is one-way; epics never write back.>

## Success criteria

<Verifiable end-states that mean this epic's area is v1 for the slice in scope. The two acceptance bars — provider-swap = one adapter, zero consumer change; new-app adoption = config only, zero library change — are the hard test.>

- <criterion>
- <criterion>

## Development prerequisites

<!--
Optional. External setup Claude Code genuinely cannot reach: a live analytics endpoint, an
API/personal key, CI secrets, a registry token. One bullet each. Mirror as `blocked_by:` above
(and in ROADMAP's `## Development prerequisites`) when it gates building. Delete this section if none.
NOT for acceptance, scriptable deploys, or business decisions.
-->

## Stories

<At draft: a tentative slice (a few bullets naming intended stories). AFTER the story files exist
in `stories/1-backlog/`, rewrite this as the authoritative one-line-per-story map — the builder's
single view of the epic's story landscape. One line each; no sub-bullets. Update the link target
when a story moves folders.>

- **[E<n>-S<m>](../stories/1-backlog/E<n>-S<m>-<slug>.md)** *(<api_impact>, <deps or "no deps">)* — one-sentence Scope.In.

## Out of scope

- <thing that looks related but waits — name the cycle/epic it belongs to instead>

## Notes

<Load-bearing decisions locked at the epic level so stories don't re-litigate them (adapter shape,
enforcement point, flush trigger, …). One-line attribution for any `architect` /
`posthog-source-guide` consult, e.g. `— architect (2026-07-07): ...`.>

## Expansion path

<!--
Optional. How this epic's surface extends later (the next adapter, the next target) without
breaking the seam — additive-only. Delete this section if not applicable.
-->
