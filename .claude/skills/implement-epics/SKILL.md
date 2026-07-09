---
name: implement-epics
description: Orchestrates a sequence of epics end-to-end. For each epic in turn — has PM draft stories just-in-time, runs a story-refinement pass, then drives the per-story build + review + close lifecycle, runs the post-close improvement pass automatically, then moves to the next. Use when the user says "implement E<a> E<b> E<c>", "ship E<a> then E<b>", "roll through the cycle", "/implement-epics ...", or wants to drive one or more sequenced epics with one command. The single entry point for end-to-end epic execution.
---

# implement-epics

## What this does

Orchestrates a **sequence** of epics end-to-end (a single epic is just a sequence of one). For each epic in the order given:

1. **PM prep (just-in-time)** — flip the epic to `*(active)*` in ROADMAP; draft story files in `planning/stories/2-ready-for-dev/`; pre-resolve decisions the epic file locks. **Spawn `architect` on real Open Questions** the PM can't pre-resolve from the epic + research + code; **stop and ask the user** only if architect input still leaves the question unresolved.
2. **Story refinement pass** — dispatch `story-refiner` to read PM's drafts against the real code surface, apply sizing-recalibrations, code-shape fixes, self-contradiction resolutions, cross-story coordination wrinkles, and missing Technical-note pin-downs directly to the story files. Refiner consults architect / posthog-js source / builder / pm as needed. Surfaces non-blocking concerns in its report but does NOT pause for user input under default flow.
3. **Story-by-story execution** — for each story in dependency order: move to `3-in-progress/`, dispatch `builder`, wait, move to `4-review/`, dispatch `architect-reviewer`, ship to `5-done/` with a `## Shipped` section (or retry up to 2× on critical issues). Capture reviewer suggestions into the story's Technical notes as `> Reviewer suggestion (YYYY-MM-DD): ...` lines — seeds for the improvement pass.
4. **Close the epic** — flip status to `done`, archive the epic file to `epics/done/`, sync the closed bullet in ROADMAP (in-cycle bookkeeping only).
5. **Post-close improvement pass** — automatic (no asking). Builder addresses all actionable residual reviewer suggestions; architect-reviewer verifies; `## Follow-up` sections appended to affected story files.
6. **Move on to the next epic** in the sequence.

Epics are done on dev-close (`status: done`) — dev-done == done. The only thing that can leave an epic parked is an open external development prerequisite (`blocked_by`).

When the full sequence completes, surface the cycle-completion status (if applicable) **but do not promote cycles** — that stays user-driven per PM rules.

Invoking this skill IS the user's authorization to drive ALL the per-epic lifecycle moves on their behalf, including the post-close improvement pass on every epic. The skill still pauses for user input at well-defined gates (genuine Open Questions PM + architect can't resolve, critical reviewer issues, retry caps).

## Arguments

Required: **a list of epic identifiers in execution order, OR the keyword `all`.**

**Explicit-list form** — Examples:
- `/implement-epics FF-2 FF-3 FF-4`
- `/implement-epics E12 E13`
- `/implement-epics CAP-2 CAP-3-batching CAP-4-flush` (mixed short / full forms)
- `/implement-epics SR-1 SR-2 SR-3`

**`all` form** — `/implement-epics all` resolves to "every epic listed under `## NOW` in ROADMAP.md, in roadmap-listed order, filtered to `status: planned` or `status: active`, **AND not blocked by an open gate** (see `blocked_by` below)." Examples:
- `/implement-epics all` when NOW lists FF-1 / FF-2 / FF-3 → expands to `FF-1 FF-2 FF-3` and proceeds.
- `/implement-epics all` when NOW lists nothing (cycle open-but-unscoped) → stop and report "no NOW epics to ship; PM hasn't drafted any yet."
- `/implement-epics all` when NOW lists one in-flight `*(active)*` + two `*(planned)*` → expands to all three in roadmap order; the active one resumes from current folder state per the normal resumability rule.

`all` does NOT include UPCOMING or LATER epics — those are explicitly out of scope. If the user wants those they list them explicitly. `all` also does NOT include any epic whose `status:` frontmatter is `done` — those are silently filtered out (already shipped; no-op).

**Gated epics (`blocked_by`).** An epic may carry `blocked_by: <gate>` in its frontmatter — an open development prerequisite (external setup CC can't reach: a PostHog project + API key, a self-hosted endpoint, CI secrets) or another epic ID. `all` **skips** any epic whose gate is still open and logs it (`skipped: blocked_by <gate> (open)`), because it's parked, not buildable. This is the machine-readable form of the NOW "Deferred" / gated grouping. When the gate clears (the external prerequisite lands / the blocking epic ships), remove `blocked_by` and the epic becomes buildable. *(Example: with an `ADAPTER` epic and a live-integration epic both `blocked_by: posthog-project-key` and that prerequisite open, `all` over a NOW of {FF-1, ADP-2, LIVE-1} resolves to **just FF-1**.)*

If a given ID is ambiguous, list candidates and ask.

## Default behaviors (don't ask each time)

These are the defaults the user established when this skill was created. Honor them silently unless the user overrides at invocation time:

- **Story drafting timing: just-in-time.** PM drafts each epic's stories AFTER the previous epic closes — so the new stories can reflect what actually shipped upstream. Do NOT pre-draft the whole sequence's stories up-front.
- **Story refinement pass: always, automatic.** After PM finishes drafting and before builder kickoff, dispatch `story-refiner` to apply implementation-readiness fixes directly to the story files (sizing recalibrations, code-shape contradictions, self-contradictions, cross-story coordination, missing Technical-note pin-downs). Refiner surfaces non-blocking concerns in its report; do NOT pause for user input on those — the user sees them in the orchestrator's final report. Only pause if refiner hits a genuine Open Question that survives architect consult (same hard gate as PM).
- **Improvement run on every epic close: yes, automatic (option (a)).** Address all actionable residual reviewer suggestions inline; do NOT pause to ask "improvement run, defer, or selective?". Captured suggestions that genuinely can't be addressed in scope (e.g. story-template wording fixes, cross-target/cross-adapter refactors) are skipped with documented reason.
- **Commit cadence: per-shipped-story + per-epic-boundary commits.**
  - One commit per shipped story, message = story title (verbatim from frontmatter).
  - One `<family> <N> epic init` commit after PM prep (epic-active flip + story files in `2-ready-for-dev/`).
  - One `<family> <N> stories refined` commit after the refinement pass (skip if refiner made no edits).
  - One `<family> <N> epic close` commit after epic-archive + ROADMAP sync.
  - One `<family> <N> improvement pass` commit after the post-close improvement pass.
  - Use the epic ID's letter+number prefix; e.g. `FF3` for `FF-3`, `E12` for `E12-...`. Adapt the verb if the epic family isn't `FF` (e.g. `CAP2 epic init`).
- **Cycle promotion (NOW→UPCOMING→LATER): NEVER auto.** When the last epic in the sequence closes, surface cycle-completion status in the final report. Do NOT touch NOW / UPCOMING / LATER sections of ROADMAP.
- **Genuinely-external setup goes to `## Development prerequisites`, not into prose.** Whenever any agent in the run (PM, builder, refiner) surfaces setup CC genuinely cannot reach — a PostHog project + API key, a self-hosted analytics endpoint, CI secrets, a published-package registry token — record it as a one-line bullet in ROADMAP's `## Development prerequisites` section, plus `blocked_by` on the epic if it gates building. Do NOT bury it in epic-file prose or only in the final report. **Do NOT create prerequisites for acceptance, for deploys CC could script, or for business decisions** — those are not development prerequisites.

## Workflow

### Step 1 — Confirm the sequence

**If the user passed `all`**, resolve it first:
- Read `planning/ROADMAP.md` and parse the `## NOW` section's epic entries in the order they appear (table rows under `| Epic | Status | Ships |`, or bullets). Each entry has a markdown link to `epics/<id>.md`; extract the epic ID from each link.
- For each extracted ID, read `planning/epics/<id>.md`'s frontmatter `status:` and `blocked_by:`. Keep `planned` and `active`; silently drop `done`. **Also drop any epic with an open `blocked_by` gate** (an open development prerequisite, or an unshipped epic) — log each as `skipped: blocked_by <gate> (open)` so the user sees what's parked and why.
- If the resulting list is empty (no NOW epics, or all `done`), STOP. Report "no NOW epics to ship; PM hasn't drafted any yet" or "all NOW epics are already done." Do not proceed.
- The resulting list IS the sequence — proceed to the explicit-list resolution below using it.

**For an explicit-list (or `all`-resolved) sequence:**
- Resolve each ID to an actual `planning/epics/<id>.md` file.
- Read each epic's frontmatter `status:` + `blocked_by:`. Acceptable starting states per epic: `planned` or `active`. (`done` blocks — already shipped.) If an **explicitly-listed** epic has an open `blocked_by` gate, do NOT silently skip it — surface the gate and ask whether to proceed anyway (naming it may be an intentional override) or attend the gate first. (`all` silently skips gated epics; an explicit list does not.)
- Read each epic's `## Stories` section for the tentative slice (informational; PM owns the final slice).
- Identify the epic family prefix (`FF`, `CAP`, `E`, etc.) for commit messages.

Present a compact plan to the user:
- Sequence: `<epic1-id> → <epic2-id> → ...` (note "(resolved from `all`)" when applicable, so the user can sanity-check the expansion)
- Current status per epic (`planned` / `active`)
- Approximate story count per epic (from the tentative slice)
- Heads-up if the final epic in the sequence is the last `*(planned)*` epic in its cycle (so cycle-completion will surface at the end)

Surface the sequence to the user as a **status update**, NOT a question. The invocation IS the authorization — do NOT pause for "yes" / "go" / confirmation. The status surface gives the user a chance to interrupt if they spot wrong roadmap state (e.g. an epic accidentally still listed in NOW after archive), but it's not a gate. Proceed directly to Step 2 after surfacing.

### Step 2 — Execute each epic (loop)

For each epic in sequence:

**2a. PM prep (just-in-time)** — dispatch the `pm` agent to:
- Flip the epic file's frontmatter `status:` `planned → active` (if not already `active`).
- Bump `updated:` to today's date.
- Add `*(active)*` tag to the epic's ROADMAP bullet (in-cycle bookkeeping only; do NOT promote cycles).
- Draft the story files into `planning/stories/2-ready-for-dev/`, mirroring the conventions of the prior shipped stories (`5-done/`). Frontmatter, Scope.In / Scope.Out / Acceptance criteria / Technical notes structure all match.
- Pre-resolve decisions the epic locks (adapter shape chosen, allowlist-enforcement point locked, batch-flush trigger fixed, etc.) in story Technical notes.
- For decisions NOT pre-resolved in the epic file or prior cycle precedents: **spawn the `architect` agent** to research the `posthog-js/` source + the surrounding code/research. If the architect's input still leaves the question genuinely unresolved, **drop the story in `1-backlog/`** with the Open Question called out, and **stop** the whole skill at the post-PM gate — the user must answer the question before the orchestration can resume.
- Rewrite the epic's `## Stories` section into the authoritative post-creation form with file links + dependency-graph shape.

PM reports back with: paths of story files written; folder each landed in; any Open Questions surfaced (+ architect-consult outcome); dependency-graph shape; pre-resolved decisions; total story count.

**2b. Hard gate — if any story landed in `1-backlog/` with an Open Question** that survived the architect consult: stop. Surface the question(s) to the user. Do NOT proceed to execution. Do NOT proceed to subsequent epics. User answers → user re-invokes the skill (which then re-enters at this epic's PM stage, or proceeds if PM already updated the story).

**2c. Commit PM prep** — `git add -A && git commit -m "<family> <N> epic init"` (e.g. `FF2 epic init`).

**2d. Story refinement pass** — dispatch the `story-refiner` agent with:
- The epic file path
- The N drafted story file paths (in `2-ready-for-dev/`)
- Pointer to prior shipped epics in `5-done/` if this epic builds on them

The refiner reads each draft against the real code surface, applies sizing recalibrations, code-shape contradictions, self-contradictions, cross-story coordination wrinkles, and missing Technical-note pin-downs directly to the story files. It consults architect / posthog-js source / builder / pm freely; surfaces non-blocking concerns in its report.

**Hard gate — if the refiner stops with a genuine Open Question** that survived its consultations: stop the whole skill. Surface to the user. Same posture as PM's architect-consult-then-stop discipline.

Otherwise: capture the refiner's "Concerns flagged for user input" in the orchestrator's final report (Step 3), but DO NOT pause here — continue to step 2e.

**2e. Commit refinement pass** — if the refiner made edits: `git add -A && git commit -m "<family> <N> stories refined"`. If the refiner made no edits (PM's drafts were already clean), skip this commit; note it in the final report.

**2f. Story-by-story execution.** Inventory the epic's stories from the ROADMAP/epic Stories section. Topo-sort by `depends_on` frontmatter (cycle detected → stop, report). For each story in dependency order, run the **per-story lifecycle** below.

**Per-story lifecycle (run for each story in turn):**

**2f-i. Move into in-progress.**
- If story is in `2-ready-for-dev/`: move to `3-in-progress/` via `git mv` (preserves history).
- If in `3-in-progress/` already: continue (resuming an interrupted run).
- If in `1-backlog/`: move directly to `3-in-progress/` (invoking this skill IS the promotion signal for this epic's stories).

**2f-ii. Capture the diff base.** Before dispatching the builder, capture `git rev-parse HEAD` — this is the base for the reviewer's diff scope.

**2f-iii. Brief the builder.** Spawn the `builder` agent (subagent_type = `builder`). Provide:
- **Path to the story file** (in `3-in-progress/`) + full content
- **Path to the epic file** + full content (sibling-story context lives in its "Stories" section)
- **For each already-completed sibling story** (in `5-done/`): a one-line pointer to its `## Shipped` section — commit hash if resolvable via `git log`, otherwise paths modified, otherwise resulting public API names. This is what the builder needs to make shape-compatible decisions.
- **Story area + touches** — the builder reads these from frontmatter but call them out explicitly so it knows which `posthog-js/` packages + library modules to read. There are no area-specialist agents — the builder reads the `posthog-js/` source (capture/identify/persistence → `browser` + `core`; server capture → `node`; flags → `core` + `browser` + `node`; React → `react`) and the library's own module directly, consults `architect` for pattern/shape questions, and can consult the `posthog-source-guide` agent for how PostHog itself implements a capability (the read-only analog of the removed area-specialists).
- **Test scope hint** — the narrowest test path that should pass; the builder runs broader tests on top.
- **Hard constraints** (repeat from the builder's contract so they're inline in the brief):
  - Do NOT modify the ROADMAP, the epic file, or any other story files.
  - Do NOT change folder locations of stories. The skill does that.
  - Implement only what's in the story's **Scope.In**. Defer **Scope.Out** with no exceptions.
  - Do NOT commit / push / PR. Run tests; the orchestrator commits.

The builder's contract already grants consultation rights (architect / posthog-js source / pm / user) and specifies the structured report format. You don't need to re-grant them per call — but if the builder returns a free-form summary instead of the structured report, ask for the structured version before moving the story to review.

**2f-iv. Wait for builder to complete.** When done, `git mv` the story file `3-in-progress/` → `4-review/`.

**2f-v. Dispatch the architect-reviewer.** Spawn `architect-reviewer` (subagent_type = `architect-reviewer`) with:
- **Scope of diff to review**: changes since this story started. Pass the commit captured in 2f-ii as the diff base. If the builder didn't commit (it shouldn't — that's the orchestrator's job), use the unstaged + staged diff.
- **Story file** (for acceptance criteria)
- **Constraint**: focus the review on this story's diff, not unrelated code. Map issues to the patterns in the architect-reviewer agent's own checklist.

Parse the review's "Issues" section. Each issue is tagged `critical` or `suggestion`.

**2f-vi. Handle review outcome.**
- **No critical issues** (suggestions only, or none):
  1. Append the captured `> Reviewer suggestion (YYYY-MM-DD): <text>` lines to the story's "Technical notes" section — one line per suggestion. Don't lose them; they feed the improvement pass.
  2. Fill the story's `## Shipped` section (see "Shipped section format" below) — the story template ships the heading empty with a placeholder comment; replace the placeholder under the EXISTING heading, don't append a duplicate. If the heading is missing (pre-template story), append it. The skill writes this **once**, on move to done.
  3. `git mv` the story `4-review/` → `5-done/`.
  4. Commit the code changes + the story-file folder move + Shipped-section append together, using the story title (verbatim from frontmatter) as the message (`git add -A && git commit -m "<story title>"`).
- **Critical issues present**: `git mv` the story `4-review/` → `3-in-progress/`. Re-dispatch the builder with the reviewer's feedback inline. **Cap the loop at 2 retries (3 attempts total).** On hitting the cap, stop and escalate to the user — do NOT silently keep looping.

**2f-vii. Continue to next story.**

#### Shipped section format

Append this to the story file when it moves to `5-done/`. Source the bullets from the builder's structured report (and one `git log` for the commit hash, if available).

```markdown
## Shipped

> Captured by `implement-epics` on YYYY-MM-DD.

- **Files changed:** `src/core/analytics.ts`, `src/browser/persistence.ts`
- **Files added:** `src/core/allowlist.ts` (if any)
- **New public API:** `<symbols>` (or `none — internal only`)
- **Tests added:** `<test paths + names>`
- **Commit:** `<short-sha>` on `<branch>`
- **Reviewer notes:** `none` (or `see Technical notes` if suggestions were captured)
- **Retry history:** `<n> retries (cap was 2)` if any retries happened, with a one-line note on the critical that was fixed. Omit if shipped on first attempt.
- **Cross-story seams exposed** (optional): notes for downstream stories about what this story exposes (e.g. "S5 relies on S2's adapter interface — the `capture(event, props)` signature is load-bearing").
```

Keep it tight. The next builder reads this section directly from prior `5-done/` story files — that's how it gets the "completed sibling" pointers in 2f-iii. The skill does NOT regenerate this on every dispatch; it's written once when the story closes, and re-read on demand.

**Edge case — story already in `5-done/` without a Shipped section** (e.g. a partial run done before this convention existed, or a story closed manually): note "no Shipped section captured" in the brief and leave it to the builder to consult the architect or ask the user. Don't try to reconstruct retroactively.

**2g. Close the epic.** When every story listed in the epic is in `5-done/`:
- Update the epic file's frontmatter:
  - `status: active` → `status: done`
  - Bump `updated:` to today's date.
- Update the epic's `## Stories` section: mark each line `(done)` with a link to the shipped story file in `5-done/` and the per-story commit ref.
- **Archive the epic file** by moving it from `planning/epics/` to `planning/epics/done/` via `git mv` (preserves history). The PM convention treats `epics/done/` as the closed-epic archive.
- **Sync ROADMAP.md — in-cycle bookkeeping only.** In the cycle's NOW epic table (or list):
  - Set the closed epic's **Status** to `done` — flip the table's Status cell (or swap `*(active)*`→`*(done)*` if a cycle still uses inline markers).
  - Update its link target to the archived location (`epics/done/<file>`).
  - **Keep the entry compact** — a Status flip + link update + its existing one-line "Ships" summary, nothing more. Do NOT expand it into multi-paragraph narration (consults, commit refs, supersessions); that detail belongs in the archived epic file under `epics/done/`, and any cycle-level note worth keeping goes to `planning/HISTORY.md` — never inline in ROADMAP.md.
  - Do NOT pick a new `*(active)*` epic, do NOT change NOW/UPCOMING/LATER sections, do NOT touch the cycle's focus-area framing. Those decisions stay with the user.
- Bump the `Last updated:` line at the top of ROADMAP.md to today. It is a **date plus at most one short note** — NOT an append-only changelog. Do NOT prepend a "what changed" paragraph or keep prior notes under `_Prior this update:_` markers. If the close is worth narrating, append a dated one-paragraph entry to `planning/HISTORY.md` (newest first) instead. (See memory `roadmap-slim-forward-looking`.)
- **No acceptance step.** The epic is done on close — dev-done == done. There is nothing further to file.

**ROADMAP scope** (why the skill touches it at all, and only this much):

Two distinct edits live in ROADMAP.md. The skill handles one and never the other:

1. **In-cycle status sync** — marking a closed epic `(done)` within its existing cycle, updating its link target. Mechanical; reflects state that already happened on disk. **The skill does this in 2g.**
2. **Cycle promotion** — moving NOW→UPCOMING→LATER, picking the next focal area, naming the next active epic. Strategic; depends on user judgment. **The skill never does this** — the user signals when a cycle is closing via `/roadmap promote`.

Commit: `git add -A && git commit -m "<family> <N> epic close"`.

**2h. Post-close improvement pass** (auto, option (a)):

- Aggregate all `> Reviewer suggestion (YYYY-MM-DD): <text>` entries from the affected stories' Technical-notes sections.
- Categorize each:
  - **Actionable** = sub-5-line edit; clear right answer; fits inside the "no story files / no epic file / no ROADMAP" hard constraint.
  - **Skip-with-reason** = story-file edit (meta concerns), cross-target/cross-adapter refactors, audit-trail-only notes, or items already addressed in earlier stories.
- Brief a fresh `builder` agent with the actionable list. Per-suggestion location + description + the proposed fix, hard constraints (no story/epic/ROADMAP edits; no commits), quality-gate requirement.
- Wait for builder. Dispatch `architect-reviewer` to verify each suggestion is genuinely resolved (use the actionable list as the AC). **Cap at 1 retry** — if the reviewer flags a critical issue on the first builder pass, re-dispatch builder with the feedback once; if still critical on the second pass, stop and escalate to the user.
- On reviewer approval: append `## Follow-up` sections to each affected story file in `5-done/` listing the addressed suggestions + outcome.
- Commit the code changes + the planning-repo follow-up appends together: `git add -A && git commit -m "<family> <N> improvement pass"`.

If the improvement run finds no actionable suggestions (all captured items are skip-with-reason or already addressed), skip the builder/reviewer dispatch and the commit; note "no actionable suggestions" in the final report.

**2i. Continue to the next epic** in the sequence.

### Step 3 — Final report to the user

When the sequence is complete:

- **Per-epic summary**: epic ID + title + path to archived epic file + number of stories shipped + improvement-pass outcome (count of suggestions addressed / skipped).
- **Commit list**: all commits made during this run, in order.
- **Test suite final state**: total tests passing (from the last gate run).
- **Development prerequisites surfaced this run (external blockers only)**: every external-setup blocker any agent surfaced during the run (PostHog project + API key, a self-hosted endpoint, CI secrets, a registry token CC can't reach), by what it gates. **Also list epics skipped as `blocked_by` an open gate** (id + the open gate), so the user knows what's parked and what would unblock it.
- **Cycle status**:
  - If the last epic in the sequence is the last `*(planned)*` epic in its cycle, surface that **the cycle's exit criteria are met**. State which cycle, link to the ROADMAP, name what's UPCOMING per ROADMAP's existing content. **Do NOT promote.** Frame as "your call when to roll forward."
  - If the sequence is mid-cycle, note the remaining `*(planned)*` epics in the same cycle.
- **Residual seeds** (across all epics in this run): any suggestions skipped-with-reason that might want a future PM-scoped cleanup epic. List them with their source story so the user can decide whether to seed-issue them for a cleanup epic, or leave them captured in Technical-notes for organic surfacing.

### Step 4 — If stopped mid-run

The folder + git state is the source of truth for resumability. If you stop because of an unresolved Open Question, a critical reviewer-issue retry-cap, or any other hard gate:

- Report exactly where the run stopped: which epic, which story, which step, what's blocking.
- List what shipped (commits made), what's mid-flight (epic/story in progress), what's pending (epics not yet started).
- **Do NOT roll anything back.** Re-invoking the skill on the same sequence (or the truncated remaining sequence) resumes from current state.

## Feed-shape rationale

**Why one story at a time with epic context** (for the per-story builder dispatch):

Three options were considered:

- **All stories together.** Builder sees the whole epic upfront. Risk: context bloat, over-engineering, can't react to what earlier stories actually shipped.
- **One story, plain.** Just the story file. Risk: builder makes shape-incompatible decisions because it doesn't know what siblings will do.
- **One story + epic + sibling summaries + dep results.** ← The skill uses this. Builder focuses on one slice but has the surrounding awareness to avoid stepping on siblings. Completed-sibling Shipped sections reflect what actually shipped, not what was planned.

**Why just-in-time PM drafting** (for the epic-to-epic boundary):

- **All-at-once PM drafting** (draft all stories for all epics up-front before any execution). Risk: downstream stories assume an upstream surface that turns out wrong; rework costs more than it saves. Visibility gain is small if stories are tentative-at-best until their predecessors actually ship.
- **Per-story drafting**: PM drafts one story, it ships, PM drafts the next. Risk: PM ↔ builder ping-pong dominates the orchestrator's time; no benefit over batching at the epic level since stories within an epic are usually planned together.
- **Per-epic just-in-time** ← the skill uses this. PM drafts an entire epic's stories AFTER the previous epic closes. Lets each epic's stories incorporate any shape lessons from the prior epic's shipped surface.

Don't make either of these configurable. Opinionated default beats wishy-washy switch.

## What this skill does NOT do

- **Does NOT promote cycles in ROADMAP.** Surfaces cycle-completion status in the final report; the user decides when NOW→UPCOMING rolls forward via `/roadmap promote`.
- **Does NOT operate on epics outside the user-supplied sequence.** Even if there are other `*(planned)*` epics in the same cycle, only the named ones are touched.
- **Does NOT resolve story Open Questions silently.** Spawns architect; if still unresolved, stops and asks the user.
- **Does NOT push, open PRs, or run remote operations.** Local commits only. The user merges.
- **Does NOT run epics in parallel.** Sequential only. Multi-epic parallelism would dilute reviewer attention and tangle commit history; not worth the speedup.
- **Does NOT run stories in parallel.** One story at a time — the per-story diff-base mechanism (2f-ii) assumes a single in-flight story against a known base commit.
- **Does NOT skip the improvement pass** when reviewer suggestions exist. Auto-(a) every time.

## Examples

**User:** `/implement-epics FF-2 FF-3 FF-4`
→ Confirm the 3-epic sequence and current statuses.
→ For each in turn: PM drafts stories just-in-time; commit `FF <n> epic init`; refinement pass (commit if edits); story-by-story builder + reviewer + per-story commits; commit `FF <n> epic close`; improvement pass; commit `FF <n> improvement pass`.
→ Final report flags that FF-4 closes the `feature-flags` cycle (since FF-1 was already done before this run). Cycle promotion stays user-driven.

**User:** `/implement-epics E12 E13`
→ Same flow, E-family commit prefix (`E12 epic init`, `E13 improvement pass`, etc).

**User:** `/implement-epics FF-3 FF-2`
→ Stop and ask. FF-3 lists FF-2 as a prerequisite (or any dep ordering inconsistency). The skill doesn't silently reorder — if the user's order conflicts with the dep graph, surface it for confirmation.

**User:** `/implement-epics CAP-2` (single epic)
→ Full lifecycle on one epic: PM prep + refinement + per-story execution + close + improvement pass. The "I want the full lifecycle treatment, opinionated defaults, no per-gate asking" entry point for one epic.

**User:** `/implement-epics all` (when NOW lists SR-1 / SR-2 / SR-3)
→ Resolve `all` against ROADMAP's `## NOW` section: extract `SR-1`, `SR-2`, `SR-3` in roadmap-listed order. Confirm the expansion ("Resolved from `all`: SR-1 → SR-2 → SR-3"). Then proceed exactly as if the user had typed `/implement-epics SR-1 SR-2 SR-3`. Closing the last epic in the resolved list also closes the cycle; final report flags cycle-completion. Cycle promotion still stays user-driven.

**User:** `/implement-epics all` (when NOW lists no epics)
→ Stop and report "no NOW epics to ship; PM hasn't drafted any yet." Do not auto-dispatch PM to draft; that's a separate user-driven step via `/roadmap`.

## Failure modes to watch for

- **PM spawns architect, architect spawns architect again** — circular consult chain. Cap PM's architect consult at one per Open Question. If still unresolved, stop and ask user.
- **Builder loops on a single decision** — same question asked twice → escalate to user immediately, don't re-dispatch a third time.
- **Builder hits the same critical-issue retry cap on the improvement run** — same escalation: stop, surface, do not silently keep looping.
- **Reviewer flags an architectural shift** (not a bug — a wrong-shape concern) → stop and consult the user. May indicate the story shape itself is wrong; goes back to PM, not back to builder.
- **Story file modified during the run** (user edited it manually) → re-read it before continuing. Treat the file as the source of truth.
- **Tests pass but ACs not confirmed** — builder reported "done" without ticking each AC bullet → ask the builder to confirm explicitly before moving to review.
- **Builder writes outside the story's stated area** — e.g. a `feature-flags` story turns into substantial edits in `src/browser/` autocapture — stop, report, and ask whether scope is actually wrong (back to PM) or whether the builder should read the relevant `posthog-js/` source + consult architect before continuing.
- **An epic's PM prep generates a different story slice than the epic's tentative `## Stories` section** — that's expected and fine; PM is the source of truth for the final slice. Just make sure the epic's `## Stories` section gets rewritten to match what PM actually produced.
- **The user committed something mid-skill that overlaps with what the skill is about to commit** — read `git status` before each commit; if there are unexpected staged changes, surface them and ask before committing.
- **Consistency-check discipline catches doc-vs-shipped drift during a docs-pass story** — this is the discipline working as designed: the docs-pass builder catches it, the reviewer flags it, the orchestrator dispatches builder for a targeted fix, story closes clean. Do NOT skip the architect-review pass on docs-only stories — that's where these catches happen.
