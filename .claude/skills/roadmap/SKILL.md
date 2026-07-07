---
name: roadmap
description: Roadmap maintenance + cycle-bridging — read current state, promote cycles (NOW→UPCOMING→LATER), dispatch PM to draft current-area epics, and hand off to `/implement-epics`. Use when defining the roadmap, promoting a closed cycle to the next focus area, getting PM to draft a new NOW area's epics, adding/dropping LATER items, or amending an in-flight cycle's scope. NOT for story drafting (that's `/implement-epics`) or per-epic execution (that's `/implement-epics`).
---

# roadmap

## What this does

Orchestrates roadmap-level work and bridges cycle-close to next-cycle-start:

1. **status** (default) — read-only audit of NOW/UPCOMING/LATER + cycle-close detection
2. **define / init** — initial roadmap drafting for an empty or not-yet-populated ROADMAP
3. **promote** — the bridge: NOW→UPCOMING→LATER shuffle + PM-drafts-new-NOW-epics + handoff to `/implement-epics`
4. **add-later / drop-later** — granular LATER maintenance
5. **amend** — mid-cycle scope adjustment to an in-flight epic's `## Stories` section or the cycle's NOW framing

The **promote** lane is the load-bearing one — it's the connective tissue between `/implement-epics all` closing a cycle and the next cycle starting. PM drafts the new cycle's epics, then `epic-refiner` validates them (catching architect-spawn shortcuts, closing open questions, applying gap fixes), then one user-input pause reviews the architect-validated state before kicking off implementation. The promotion sequence (UPCOMING→NOW + LATER→UPCOMING + Status framing) is fully delegated by default — see Default behaviors below.

This skill is **one level above** `/implement-epics`. It owns the roadmap surface; `/implement-epics` owns the per-epic execution surface. The skill **never** drafts stories, dispatches builders, or runs reviewers — those are downstream skills' jobs.

## Arguments

Required: an **action verb**. Examples:

- `/roadmap` (no-arg) → defaults to `status`
- `/roadmap status` → read-only audit
- `/roadmap define` (or `init`) → initial roadmap drafting
- `/roadmap promote` → the bridge (cycle-close → next-cycle-start)
- `/roadmap add-later <area-name>` → stash a new LATER item
- `/roadmap drop-later <area-name>` → remove a LATER item
- `/roadmap amend <epic-id>` → mid-cycle scope adjustment

Free-form prose after the action is acceptable — e.g. `/roadmap add-later observability because SOTA SDKs surface delivery diagnostics` is parsed for area name + rationale.

If the action is ambiguous (`promote` when no cycle has closed; `define` when ROADMAP already exists with content), the skill stops, surfaces the conflict, and asks before mutating.

## Default behaviors (don't ask each time)

These are the defaults the user established when this skill was created. Honor them silently unless the user overrides at invocation time:

- **SOTA-driven prioritization, NOT consumer-pull-gated.** The user has explicitly rejected consumer-pull-gating (standing posture `feedback_sota_not_consumer_pull.md`). When PM drafts epics for a new NOW area, it MUST draft against SOTA reference patterns, not wait for consumer pulls. When promoting LATER→UPCOMING, prefer items whose framing argues for SOTA bar advancement; don't filter out items because "no consumer has asked." Do NOT use "consumer-pull-gated" language in any ROADMAP edits or PM dispatches.
- **PostHog OSS source is canonical.** The reference for capability, behavior, and shape questions is PostHog's own open-source monorepo, checked out locally at the repo root as `posthog-js/` (`PostHog/posthog-js`, read at its current HEAD) — navigate its `packages/*` (`core` / `browser` / `node` / `react`) directly; there is no router file. PostHog-mechanics questions (behavior, defaults, wire shape) can also be routed through the read-only `posthog-source-guide` agent. PM dispatches for new-area epic drafting MUST instruct PM to spawn `architect` against the `posthog-js/` source for SOTA-shape research on load-bearing design questions.
- **Cycle promotion is user-triggered, never auto.** The skill never fires `promote` on its own — the user must invoke `/roadmap promote`. That invocation IS the user's signal that the cycle is closing; no further confirmation is required for the standard shuffle.
- **UPCOMING → NOW is auto-confirmed.** The ROADMAP's existing UPCOMING area becomes the new NOW on cycle close. The locked sequence in the ROADMAP is honored without a pause — the user already committed to it when UPCOMING was set. To override the sequence (e.g. skip UPCOMING; pull a LATER item directly into NOW), pass it inline: `/roadmap promote --override-upcoming <area-name>`. Otherwise no pause.
- **LATER → UPCOMING is PM-prioritized.** PM evaluates the LATER shelf against the SOTA bar and picks the strongest-arguing item to promote into UPCOMING. PM's pick + rationale surfaces at pause #2 alongside the new NOW epic drafts. To force a specific pick, pass it inline: `/roadmap promote --pick-upcoming <area-name>`. To leave UPCOMING empty (rare), pass `--no-upcoming`.
- **Status-paragraph framing is PM-owned — but stays SHORT.** The skill instructs PM to keep `## Status` to ONE short current-state paragraph and add the just-closed cycle as ONE new row in the `## Cycle history` table. Any closed-cycle narrative (scope shifts, notable findings, follow-ups deferred) goes to `planning/HISTORY.md`, **never inline in Status/NOW**. The user reviews everything at pause #2. (See memory `roadmap-slim-forward-looking`: the append-never-delete habit bloated the ROADMAP to 115 KB / a single 42 KB line; the roadmap is forward-looking, the narrative lives in `HISTORY.md`.)
- **One user-input pause in `promote`:** review PM-drafted epics + the full ROADMAP rewrite before `/implement-epics` handoff. Hard gate; the skill stops and waits. The pause is the single chokepoint where the user can push back on PM's LATER→UPCOMING pick, the new NOW framing, the epic slicing, locked decisions, dependencies, or any Status-paragraph framing PM chose.
- **Epic drafting on promotion: always, unless user opts out.** Once NOW is promoted to a new area, PM is dispatched to draft that area's epics. Pause #2 surfaces the drafts. If the user wants to defer drafting (e.g. they need to do research first), `/roadmap promote --no-draft` skips step 4-5 — but the default is to draft.
- **Commit cadence: one commit per logical state change.**
  - `roadmap status` → no commits (read-only).
  - `roadmap define` → one commit `Define roadmap: <areas>` after user-approved initial draft.
  - `roadmap promote` → up to four commits: `<area> cycle promote` (NOW→UPCOMING→LATER shuffle), `<area> cycle drafted` (PM's raw epic drafts), `<area> cycle refined` (epic-refiner's pass — architect validation + cross-epic consistency + ROADMAP NOW sync), then `/implement-epics` takes over.
  - `roadmap add-later <area>` → one commit `Add LATER: <area>`.
  - `roadmap drop-later <area>` → one commit `Drop LATER: <area>`.
  - `roadmap amend <epic-id>` → one commit `<epic-id> scope amended`.
- **`epic-refiner` runs after PM drafts.** A mandatory refinement pass (analogue of `story-refiner` at the epic layer) sits between PM's draft and pause #2. It enforces architect-spawn (catching PM's documented shortcut), validates locked decisions against the `posthog-js/` source, closes open story-level questions, applies gap fixes, syncs the ROADMAP NOW section, and surfaces a clean architect-validated state for the user to review. The user sees epic-refiner's output, not PM's raw output. To skip (rare; e.g. one-shot internal-only cycle where the user wants raw PM): `/roadmap promote --no-refine`.
- **`Last updated:` bump on every mutation.** Set to today's DATE plus at most one short clause. **NEVER a prepended `Prior: … Prior same-day: …` changelog chain** — that habit grew the line to 42 KB. Close narrative belongs in `planning/HISTORY.md`, not here.
- **`## Status` paragraph maintenance.** On promotion, keep Status to ONE short current-state paragraph (pre-1.0 framing + "N cycles complete, current focus = X" + pointers to `HISTORY.md` and `epics/done/`). The just-closed cycle gets ONE new row in the `## Cycle history` table (cycle/area · closed · epics→`epics/done/`) — NOT a paragraph inlined into Status. Per-epic detail already lives in `epics/done/*.md`; do not duplicate it. PM owns the (short) prose; any longer narrative → `HISTORY.md`.
- **Never edit story files or per-epic story slices.** Those are PM's territory when dispatched by `/implement-epics`. This skill operates at the ROADMAP + epic-file level only.

## Workflow

### Action: `status` (read-only)

1. Read `planning/ROADMAP.md` end-to-end. Parse:
   - `Last updated:` date (flag if stale, e.g. > 14 days)
   - `## Status` paragraph (cycle counts, focus-area history)
   - `## NOW` section: focus area, listed epics with `*(planned)*` / `*(active)*` / `*(done)*` tags
   - `## UPCOMING` section: next focus area, seed scope
   - `## LATER` section: bulleted areas
2. For each NOW epic, read its file's frontmatter `status:` + the `## Stories` section to count stories.
3. Cross-check epic-file status against ROADMAP tags (catch drift — e.g. epic file says `done` but ROADMAP still shows `*(active)*`).
4. Detect cycle-close state: are ALL listed NOW epics `done`? If yes, surface as "cycle exit criteria met — ready for `/roadmap promote`."
5. Report compactly:
   - Cycle status (mid-cycle vs closed)
   - Per-epic snapshot (id + status + story count)
   - Any drift between ROADMAP and epic files (CRITICAL signal — surface for user fix)
   - `Last updated:` staleness flag
   - Suggested next action (`/roadmap promote` if closed; `/implement-epics all` if NOW has unshipped epics; "no action needed" otherwise)

Do NOT mutate. Do NOT commit.

### Action: `define` (initial roadmap drafting)

For an empty or not-yet-populated ROADMAP. Skip if ROADMAP already has substantive NOW/UPCOMING/LATER content (surface conflict + ask).

1. Confirm initial state: read ROADMAP. If it's already populated, stop and ask whether the user wants to RESET (destructive — back up first) or AMEND (use `amend` instead).
2. **User-input pause #1:** ask the user for:
   - Project tagline / what the codebase is
   - Initial focus area for NOW (single area)
   - Optional: a known UPCOMING area
   - Optional: known LATER items
   - Any research notes pointers (e.g. `planning/research/`)
3. Dispatch `pm` agent with the user's inputs + the no-consumer-pull-gating posture + the `posthog-js/` source pointer. PM drafts:
   - `## Status` opener paragraph (cycle count = 0, focus area named)
   - `## Sequencing principle` paragraph (area-first focus cycles)
   - `## NOW` section with focus-area framing + seed-epics list (empty if not drafted yet)
   - `## UPCOMING` section (if provided)
   - `## LATER` section bullets
   - `## How to read this file` footer
4. **User-input pause #2:** show the drafted ROADMAP. Ask for review/edits.
5. On approval: commit `Define roadmap: <areas>`.
6. Suggest the next step:
   - If NOW area has seed epics named, suggest `/roadmap promote` (which will draft the epics) OR direct PM dispatch.
   - Otherwise, suggest `/roadmap add-later` to populate LATER first.

### Action: `promote` (the bridge — cycle-close → next-cycle-start)

This is the load-bearing flow. Six steps, **one** user-input pause (review PM-drafted epics at the end).

**Step 1: Detect cycle-close state.**

Read ROADMAP + each NOW epic's frontmatter `status:`. Cases:

- **All NOW epics `done`** → cycle exit criteria met. Proceed to Step 2.
- **Some NOW epics not `done`** → surface mid-cycle state. Ask user: "Cycle is mid-flight (X of Y epics done). Promote anyway (forces NOW area into LATER as `*partially-shipped*`)? Or finish remaining epics first?" (This is the only conditional user prompt — exists because mid-cycle promotion is genuinely destructive.)
- **NOW is empty** (no listed epics) → cycle is open-but-unscoped. Surface this; `promote` is the wrong tool — `/roadmap define` or a direct PM dispatch for epic-drafting is the right move. Stop.

**Step 2: Announce cycle closure (informational, no pause).**

Surface compactly to the user:
- Closing NOW area + the epics that landed
- UPCOMING area that's about to become NOW (the locked sequence — honor unless `--override-upcoming` was passed)
- LATER shelf contents (PM will pick one in Step 3 unless `--pick-upcoming` or `--no-upcoming` was passed)

This is a status update, not a question. Proceed directly to Step 3.

**Step 3: ROADMAP shuffle + first commit (PM dispatched).**

Dispatch `pm` agent with explicit instructions:

- **Pick LATER → UPCOMING** (unless overridden by flag): evaluate every LATER item against the SOTA bar and the user's saved roadmap-shaping memories. Pick the item whose framing argues most strongly for SOTA-bar advancement. Report the pick + a one-paragraph rationale (what SOTA argument carried it; which alternatives were considered and why they ranked lower). NO consumer-pull-gating language.
- **Update `## Status` (keep it SHORT) + add a `## Cycle history` row**: rewrite Status as ONE short current-state paragraph (cycle count + current focus + pointers to `HISTORY.md`/`epics/done/`). Add the just-closed cycle as ONE new row in the `## Cycle history` table (cycle/area · closed · epics→`epics/done/`). Any narrative PM judges worth keeping (scope shifts, notable findings, follow-ups deferred) goes to `planning/HISTORY.md` — **NOT inlined into Status/NOW**. Do NOT prepend a `Prior: …` chain to `Last updated:`. (See memory `roadmap-slim-forward-looking`.)
- **`## NOW` section**: rewrite focus-area framing for the new NOW area — a few short paragraphs at most. Copy framing from the previous UPCOMING section as a starting point (PM owns final prose). Strip any consumer-pull-gating language per the SOTA-driven posture. **Strip any "preserved for archival continuity" prose of the just-closed cycle from NOW → it moves to `HISTORY.md`.** Leave the listed-epics section empty for now (PM will fill it in Step 4).
- **`## UPCOMING` section**: rewrite for the PM-picked LATER item. Adapt the LATER bullet's framing into a fuller UPCOMING framing.
- **`## LATER` section**: remove the promoted item; leave the rest in their existing order.
- **`Last updated:`** → today's date.

PM reports back: the LATER→UPCOMING pick + rationale, plus a summary of the rewrite.

Commit: `<area> cycle promote` (where `<area>` is the new NOW area's name, e.g. `feature-flags cycle promote`).

**Step 4: PM drafts new NOW area's epics.**

Dispatch `pm` agent with explicit instructions:

- Read the new NOW area's framing (just-rewritten in step 3).
- Slice the area into N epics following the substrate-then-specialization-then-recipe pattern (capture cycle / identify cycle precedents).
- **Spawn the `architect` agent first** (literal `Agent({subagent_type: 'architect', ...})` call) against the `posthog-js/` source (navigate `posthog-js/packages/*` directly — `core` / `browser` / `node` / `react`; there is no router file) for SOTA-shape research on load-bearing design questions. Apply SOTA-driven posture (NOT consumer-pull-gated). **Do NOT shortcut by reading the source directly** — the architect agent's rigor (alternatives explicitly rejected, confidence levels, gap detection) is what's required. The `epic-refiner` pass in Step 4.5 will catch and correct any shortcut, but the cost of catching it after PM commits is much higher than doing it right the first time.
- Draft epic files into `planning/epics/<id>.md`. Each epic's frontmatter `status: planned`; `## Stories` section tentative (final slice happens at `/implement-epics` time).
- Each epic file MUST capture load-bearing decisions in its `## Notes` section (so stories don't re-litigate them).
- Update ROADMAP's `## NOW` listed-epics block with the drafted epic links + one-line summaries + dependency graph.

PM reports back: number of epics drafted, dependency graph, locked decisions, any Open Questions surfaced, **and an explicit "I spawned the architect agent" statement summarizing architect's outputs**.

Commit: `<area> cycle drafted` (e.g. `feature-flags cycle drafted`). This is PM's raw output — visible in git history as the input to the next step.

**Step 4.5: `epic-refiner` runs (mandatory unless `--no-refine` was passed).**

Dispatch the `epic-refiner` agent. Give it:

- The just-rewritten `## NOW` section as context.
- The N drafted epic file paths.
- PM's full dispatch report from Step 4 (the architect-spawn statement is the load-bearing signal — epic-refiner uses it to detect the shortcut).
- The list of saved-feedback memories that apply to roadmap/epic framing (e.g. `feedback_sota_not_consumer_pull.md`, `feedback_vendor_neutral.md`).

`epic-refiner` will:

1. Detect whether PM actually spawned architect (vs. shortcut by reading the source directly). If shortcut detected → epic-refiner spawns `architect` itself, applies the outcome to epic files.
2. Validate PM-locked decisions against the `posthog-js/` source.
3. Close open story-level questions where architect has high or medium-high confidence.
4. Apply gap fixes (missing forward-pointers, framing-feedback violations, vendor-neutral-seam mechanics undersold, etc.).
5. Sync the ROADMAP `## NOW` section to the refined epic state (links, one-line summaries, dependency graph, exit criteria).
6. Surface a structured report: architect-spawn verdict, per-epic edits applied, ROADMAP NOW sync details, concerns flagged for user input.

epic-refiner edits epic files + ROADMAP NOW section ONLY. It does not touch src/, tests/, story files (don't exist yet), or other cycles' epic files.

Commit: `<area> cycle refined` (e.g. `feature-flags cycle refined`). User can diff this against `<area> cycle drafted` to see what refinement caught.

**Step 5: User-input pause — review the architect-validated cycle state.**

This is the single chokepoint. Surface everything in one place:

- **The LATER → UPCOMING pick PM made + rationale** (the SOTA argument PM applied; alternatives considered)
- **The full rewritten `## Status` paragraph** (cycle count bumped, closed-area framing, anything notable PM recorded)
- **The rewritten `## NOW` section** as epic-refiner finalized it
- **The rewritten `## UPCOMING` section** (the LATER item PM promoted)
- **Per-epic summary** for each new NOW epic: ID, title (post-refinement), status, story count (tentative), key locked decisions, dependencies
- **epic-refiner's architect-spawn verdict** — did PM do it right, or did refiner have to spawn architect itself?
- **Per-epic edits epic-refiner applied** (concise — the report shape)
- **Any Concerns** epic-refiner flagged for user input

Ask user to confirm (or push back on any layer):
- The LATER→UPCOMING pick (override forces re-dispatch with the corrected pick + a fresh refiner pass)
- Status paragraph framing
- New NOW area framing
- Epic slicing (override specific epics or scope)
- Locked decisions
- Dependency graph
- Anything epic-refiner caught + the user wants to revisit

If user requests changes: re-dispatch PM with the feedback, then re-dispatch epic-refiner on the updated state. Repeat until user confirms.

No commit on confirmation — both `<area> cycle drafted` (Step 4) and `<area> cycle refined` (Step 4.5) already landed.

**Step 6: Handoff to `/implement-epics`.**

Offer: "Ready to `/implement-epics all`? This will drive the new NOW cycle end-to-end (per-epic PM story drafts + builder + reviewer + commits + improvement passes)."

If user confirms: surface the recommended invocation (`/implement-epics all`). User fires it explicitly; this skill does NOT auto-chain.

If user defers: report current state (epics drafted + refined, ready to ship) and stop. User can return to `/implement-epics all` later.

**Step 7: If stopped mid-flow:**

Folder + git state is source of truth. Re-invoking `/roadmap promote` resumes from current state:
- If the shuffle commit (`<area> cycle promote`) isn't there yet: re-run Step 3 (PM dispatches the shuffle).
- If the shuffle landed but the drafted commit (`<area> cycle drafted`) isn't there: re-run Step 4 (PM drafts epics).
- If the drafted commit landed but the refined commit (`<area> cycle refined`) isn't there: re-run Step 4.5 (epic-refiner pass).
- If all three commits landed but `/implement-epics` not yet fired: offer the handoff.

### Action: `add-later <area>`

1. Parse the args for area name + optional rationale.
2. Read ROADMAP's `## LATER` section.
3. Construct the new bullet matching the existing cadence (markdown link if file exists, plain area name + rationale otherwise). SOTA-bar framing preferred over consumer-pull framing.
4. Insert at the appropriate position (end by default; user can specify position).
5. **User-input pause:** show the proposed bullet, ask for review/edits.
6. On approval: commit `Add LATER: <area>`.

### Action: `drop-later <area>`

1. Find the matching bullet in `## LATER`.
2. **User-input pause:** confirm removal + ask if the area is being obsoleted (e.g. external tool shipped) or promoted-elsewhere (e.g. into a recipe doc).
3. Remove the bullet.
4. Commit `Drop LATER: <area>`.

### Action: `amend <epic-id>`

For mid-cycle scope adjustment of an in-flight epic. Common cases: stories getting folded out, scope creep, new sub-area discovered.

1. Locate the epic file: `planning/epics/<id>.md`.
2. **User-input pause:** ask what the amendment is. Options: adjust `## Stories` slice, adjust `## Out of scope`, adjust `## Notes` (locked decisions), update `updated:` date.
3. Dispatch `pm` with the requested edit (PM owns the prose).
4. **User-input pause:** show the edited epic file.
5. On approval: commit `<epic-id> scope amended`.

NOTE: this is NOT for closed epics in `epics/done/` — those are archived and amending them rewrites history. For closed-epic follow-ups, use the regular `/implement-epics` improvement-pass flow.

## Defaults that DIFFER from `/implement-epics`

- **Read-only mode is supported** (`status` action). `/implement-epics` is action-only.
- **One user-input pause** at the post-draft review chokepoint. `/implement-epics` pauses only on hard blockers (Open Questions, critical reviewer issues). Otherwise both skills run their full flow without per-step confirmation.
- **No story drafting, no builder dispatch, no reviewer dispatch.** This skill stays at the ROADMAP + epic-file level; downstream skills handle execution.
- **No improvement-pass auto-loop.** Post-promotion, the skill hands off and stops.
- **Cycle promotion is the bridging concern, not story execution.** The skill is the connective tissue between `/implement-epics all` (closes cycle N) and `/implement-epics all` (opens cycle N+1).

Everything else — per-epic execution, per-story builder/reviewer, folder-lifecycle moves, Shipped-section format, ROADMAP closed-bullet sync — defers to `/implement-epics` SKILL.md unchanged.

## What this skill does NOT do

- **Does NOT auto-promote cycles.** Cycle promotion is always user-triggered (the user must invoke `/roadmap promote`). The skill never fires it on its own, no matter how cleanly NOW has closed.
- **Does NOT draft story files.** Stories are PM's territory only via `/implement-epics`.
- **Does NOT dispatch builders or reviewers.** Those are `/implement-epics` jobs.
- **Does NOT push, open PRs, or run remote operations.** Local commits only.
- **Does NOT operate on closed epics in `epics/done/`.** Closed epics are archive; mid-cycle amendments work on `epics/<id>.md` only.
- **Does NOT chain into `/implement-epics`.** Suggests the invocation at step 6; user fires it explicitly.
- **Does NOT consume the no-consumer-pull-gating posture as a one-time setup.** The discipline is permanent per saved memory; every PM dispatch in this skill carries it.

## Examples

**User:** `/roadmap` (or `/roadmap status`)
→ Read-only audit. Reports NOW/UPCOMING/LATER snapshot + cycle-close state + drift flags + suggested next action.

**User:** `/roadmap promote` (after `capture` cycle closes)
→ Step 1: detect CAP-1/CAP-2/CAP-3 all `done`. Step 2: announce closure (no pause). Step 3: dispatch PM to (a) pick LATER→UPCOMING using SOTA reasoning, (b) shuffle Status/NOW/UPCOMING/LATER. Commit `feature-flags cycle promote`. Step 4: dispatch PM to draft `feature-flags` area epics with explicit architect-spawn instruction. Commit `feature-flags cycle drafted`. Step 4.5: dispatch `epic-refiner` to validate PM's output (detect architect-spawn shortcut + spawn architect if needed, validate locked decisions, close open questions, apply gap fixes, sync ROADMAP NOW). Commit `feature-flags cycle refined`. Step 5: pause — surface refiner's report + per-epic edits + concerns for user review (single chokepoint). Step 6: offer `/implement-epics all`.

**User:** `/roadmap promote --override-upcoming session-replay --pick-upcoming groups`
→ Same flow but UPCOMING→NOW is overridden (session-replay becomes the new NOW area instead of whatever was in UPCOMING) and PM's LATER→UPCOMING pick is forced (groups is promoted to UPCOMING instead of PM's SOTA-driven pick).

**User:** `/roadmap promote --no-draft`
→ Same flow but skip steps 4 / 4.5 / 5. Useful when the user wants to do research first before PM drafts epics, or when the new NOW area is intentionally open-but-unscoped.

**User:** `/roadmap promote --no-refine`
→ Same flow but skip Step 4.5 (epic-refiner pass). Useful for one-shot internal-only cycles where the user wants PM's raw output without refinement. Rare; the architect-spawn-shortcut detection moves back to the skill orchestrator's manual responsibility (per the failure-modes block).

**User:** `/roadmap add-later privacy SOTA SDKs enforce a payload allowlist and consumers need consent controls`
→ Parse area name + rationale. Construct LATER bullet ("**`privacy`** — SOTA analytics SDKs enforce a consumer-supplied payload allowlist and opt-out/consent; the neutral surface needs a privacy seam ..."). Pause for review. Commit.

**User:** `/roadmap amend ID-5`
→ Locate `planning/epics/done/ID-5-...md` — wait, it's archived. Surface: "ID-5 is in `epics/done/`; mid-cycle amendments only work on open epics. Did you mean a closed-epic follow-up? Use `/implement-epics` improvement-pass flow instead."

**User:** `/roadmap define` (empty ROADMAP)
→ Pause: ask for tagline + initial focus area + LATER seeds. Dispatch PM. Pause: review draft. Commit `Define roadmap: <areas>`.

## Failure modes to watch for

- **Drift between ROADMAP tags and epic-file `status:` frontmatter.** `/roadmap status` should catch this. Common cause: someone manually edited an epic file without updating ROADMAP (or vice versa). Surface as a critical signal; ask user which side is the source of truth, then sync the other.
- **PM drafts epics WITHOUT *spawning* architect.** Documented PM shortcut: PM reads the `posthog-js/` source directly and cites file:line references rather than spawning the `architect` agent. The output looks superficially complete (decisions locked, sources cited) but lacks the architect agent's rigor in (a) closing open questions instead of dangling them as "story-time architect calls," (b) considering and explicitly rejecting alternatives, (c) flagging gaps PM missed. **`epic-refiner` (Step 4.5) now catches this automatically** — it detects the shortcut from PM's report and spawns architect itself as a corrective, then applies the outcome to the epic files. The skill orchestrator no longer has to detect-and-remedy manually; just verify epic-refiner ran and its report names the architect-spawn verdict. If `--no-refine` was passed AND PM shortcut architect, the skill orchestrator must catch the shortcut itself and spawn architect as the manual fallback. Detection rule (in any code path): PM's report does NOT contain an explicit "I spawned the `architect` agent" statement, OR contains language like "consulted the source directly" / "architect-spawn was unnecessary" / unresolved "story-level architect call" notes.
- **Consumer-pull-gating language leaks into ROADMAP edits.** PM has a standing rule about consumer-pull-gating that PRE-DATES the user's SOTA-driven feedback. Every PM dispatch in this skill MUST include the "strip consumer-pull-gating language" instruction. If PM's output includes it anyway, the skill's review step (pause #2) catches and corrects.
- **User confirms promotion but then never fires `/implement-epics all`.** Folder state is fine (epics drafted, in `2-ready-for-dev/`); no rollback needed. On next session, `/roadmap status` will show the drafted-but-unshipped epics; user can fire `/implement-epics all` whenever.
- **`define` invoked on an already-populated ROADMAP.** Default is to stop and ask whether to reset (destructive). Never silently overwrite — backup the existing ROADMAP first.
- **`amend` invoked on an in-flight epic mid-`/implement-epics` run.** The orchestration may be reading the epic file concurrently. Don't edit while `/implement-epics` is running; surface the conflict and ask the user to stop the other skill first.
- **Cycle exit-criteria-met detection is incorrect** because an epic was manually archived without updating its ROADMAP bullet. Cross-check epic-file `status: done` against ROADMAP `*(done)*` tag; if they disagree, treat as drift and ask user before promoting.
