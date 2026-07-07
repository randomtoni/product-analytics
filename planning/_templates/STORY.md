---
id: E<n>-S<m>-<slug>
epic: E<n>-<AREA>-<slug>
status: backlog
area: <inherited-from-epic>
touches: []
depends_on: []
api_impact: additive
---

# E<n>-S<m>-<slug> — <Story title>

<!--
Frontmatter contract (read by /implement-epics — keep these exact):
  id          E<n>-S<m>-<slug>; no area code in story ids (inherited from the epic).
  epic        the parent epic id.
  status      backlog | ready-for-dev | in-progress | review | done. The story's FOLDER under
              stories/ is the source of truth for lifecycle; this field mirrors it. New stories
              are drafted to stories/1-backlog/ with status: backlog.
  area        inherited from the parent epic (one of the 12 canonical slugs).
  touches     other affected area slugs the builder should read; [] if none. The builder reads
              area + touches to know which posthog-js/packages/* and library modules to consult.
  depends_on  ids of sibling stories that must ship first. /implement-epics topo-sorts on this.
  api_impact  additive | behavior | breaking.
-->

## Why

<1-2 sentences: what this slice unlocks for the epic. The smallest valuable slice ships first.>

## Scope

### In

- <exactly what the builder implements — the smallest valuable slice>

### Out

- <deferred; the builder must NOT touch these in this story>

## Acceptance criteria

<Verifiable outcomes the architect-reviewer checks. Ground them in the two acceptance bars where relevant.>

- [ ] <outcome>
- [ ] <outcome>

## Technical notes

<Pin-downs the builder needs before writing code: chosen shapes, the relevant `posthog-js/packages/*`
reference to adapt (de-branded), locked decisions inherited from the epic's `## Notes`. One-line
attribution for any `architect` / `posthog-source-guide` / `builder` consult, e.g.
`— architect (2026-07-07): ...`. /implement-epics appends `> Reviewer suggestion (YYYY-MM-DD): ...`
lines here during review — these seed the post-close improvement pass.>

## Shipped

<!-- Empty at draft. /implement-epics fills this once, when the story moves to stories/5-done/
(files changed/added, new public API, tests added, commit, reviewer notes). Do not hand-edit. -->
