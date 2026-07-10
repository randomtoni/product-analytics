---
id: E13-FF-local-eval
status: done
area: feature-flags
touches: [node, adapters]
api_impact: additive
blocked_by: []
updated: 2026-07-10
---

# E13-FF-local-eval — Local (in-process) flag evaluation (server-shaped)

## Why

Local evaluation is the server-shaped half of feature-flags: with a privileged key the server pulls
flag **definitions** and evaluates them **in-process** against caller-supplied person/group
properties — no per-call network round-trip, the mode high-throughput backends need. It is a large,
self-contained, server-only machine (the `matchProperty` cohort/rollout/hashing logic is ~700 lines
in the `posthog-js` reference) with a Python-central weighting and zero browser work, so it is split
out of **E12** into its own specialization epic. Critically, it slots in **entirely behind E12's
unchanged `evaluate` method** — this epic is the regression check that E12's neutral port shape was
right: if it needs a seam change, E12 was wrong. Architect-consulted against the `posthog-js`
checkout (2026-07-10). See `E12-FF-flag-substrate-remote-eval.md`.

## Success criteria

- The node/server adapter (TS) and the Python server adapter gain **in-process local evaluation**:
  poll flag **definitions** on an interval, evaluate a `FlagContext`'s person/group properties against
  cohort/rollout/hash rules locally, and return the same `FlagSet` snapshot E12's `evaluate` already
  returns — **with ZERO change to the neutral `FeatureFlagPort`, `FlagSet`, or `FlagContext`.** The seam
  is untouched; this is the proof the E12 async-first snapshot shape holds.
- Local-vs-remote strategy is resolved **entirely adapter-internally**: `onlyEvaluateLocally` /
  `strictLocalEvaluation` / poll-interval / definition-cache are **adapter config fields** (bar B), never
  neutral port parameters. When a flag cannot be locally evaluated (cohorts, experience continuity),
  the adapter **falls back to the remote path** from E12 unless the config forbids it — the fallback
  is invisible to the consumer.
- The **definition-polling + `matchProperty` evaluator** is de-branded from
  `posthog-js/packages/node/src/extensions/feature-flags/feature-flags.ts` (TS) and the
  `posthog-python` analog (Python), at parity. Rollout-hash bucketing, property operators, and cohort
  matching produce identical results to a remote eval for the same inputs.
- **Bar A holds:** a self-hosted adapter that only supports remote eval (or only local) still satisfies
  the one `evaluate` method — local eval is a capability an adapter *may* add, never a contract every
  adapter must implement. **Bar B holds:** enabling/tuning local eval is config-only, zero library
  change.
- **Parity:** local eval advances the TS **node** adapter and the **Python server** adapter (both
  server-shaped); **no browser work** (the browser has no local mode). The parity matrix records local
  eval as a server-target capability present in both trees, absent-by-platform from the browser.
- Zero vendor references: the definitions endpoint, the `personalApiKey`-equivalent privileged-key
  config, the rule/cohort wire shapes, and the hash constants are `[WIRE]`/adapter-internal (`$`-const
  in TS, `_WIRE_*` in Python). The privileged key is a **config-supplied credential**, named by role,
  never a vendor key name.

## Development prerequisites

- **A live analytics project + a privileged (server-side, definition-reading) API key** to
  ground-truth local-eval results against a real remote eval in an integration test. Local evaluation
  must produce the same variant as the backend for the same inputs; verifying that requires a real
  definitions payload + a real remote `/flags` response to diff against (the PY8 lesson: a real-stack
  probe must exercise the real path, not a self-consistent mock). Mirrored as `blocked_by` context in
  ROADMAP's `## Development prerequisites`. Unit-level rule-matching tests need no live key; the
  ground-truth diff does.

## Stories

All four stories shipped (`stories/5-done/`). Sequence held: the shared evaluator/poller substrate (TS
node) → the resolution/fallback wiring → the Python analog at parity → the ground-truth + parity proof.
`depends_on`: `S1 → S2 → S3`; `S4` depends on `S2 + S3`. **Zero seam/port change across all four** — the
E12 `FeatureFlagPort` held; local eval is a strategy branch inside the adapters behind the unchanged
`evaluate`.

- **[E13-S1](../stories/5-done/E13-S1-node-local-evaluator-poller.md)** *(done — `797346e`)* — the pure
  in-process `matchProperty` evaluator (rollout-hash bucketing + property operators + cohort/variant
  matching + the two inconclusive signals) + the definition poller; adapter-internal (TS node), nothing
  exported. Hash independently recomputed vs the reference — the cross-tree parity anchor.
- **[E13-S2](../stories/5-done/E13-S2-node-local-remote-resolution-fallback.md)** *(done — `9f276dc`)* —
  the local-first strategy branch inside the UNCHANGED `evaluate`: fall back to E12's shipped `roundTrip`
  (ONE narrowed call for inconclusive keys), merge on the maps, no new `FlagReason`; `onlyEvaluateLocally`/
  `strictLocalEvaluation`/poll-interval/definitions-endpoint as `FlagClientConfig` fields; local-vs-remote
  indistinguishable. Narrowing to fallback keys is a deliberate improvement over the reference (zero POST
  for locally-decidable flags).
- **[E13-S3](../stories/5-done/E13-S3-python-server-local-eval.md)** *(done — `30b5724`)* — the Python
  analog at parity (evaluator + poller + fallback), sync-by-design (no asyncio), the SAME hash vector as
  S1 (float64-identical), de-branded from `posthog-python`. Poll daemon stoppable — no leaked thread
  (the E12-S4 lesson).
- **[E13-S4](../stories/5-done/E13-S4-ground-truth-parity-proof.md)** *(done — `4a3b25a`)* — the 3-layer
  proof: loopback ground-truth over a REAL socket, the cross-tree hash anchor, a skip-if-no-key live diff;
  negative controls PROVEN to bite (mutating the pinned variant failed both suites); parity-matrix + README
  corrected (flags → IMPLEMENTED; replay row left for E14). Audit-not-patch — zero library-src edits.

## Out of scope

- **The neutral port / `FlagSet` / `FlagContext` / taxonomy slot / bootstrap** — all E12. This epic
  adds NO seam surface; touching it means E12 was wrong.
- **Browser flag work** — the browser has no local mode; E12 owns the browser remote adapter.
- **`$feature_flag_called` auto-capture** and flag-context-on-events — deferred at the E12 level.

## Notes

- **Split at the eval-strategy boundary, not by language.** The natural fault line in feature-flags is
  remote eval (both targets, E12) vs local eval (server-only, here). Local eval is a large self-contained
  server-only machine with a Python-central weighting and a different risk profile; bundling it into
  E12 makes E12 huge and blurs the "does the seam hold?" test. Splitting here makes E13 a clean
  regression check on E12's neutrality. — architect (2026-07-10).
- **`onlyEvaluateLocally`/`strictLocalEvaluation` are adapter config, resolved from the config object,
  never neutral port parameters.** The node adapter reads them; the browser adapter ignores them (no
  local mode). This is the direct consequence of E12's "local-vs-remote is adapter-internal behind one
  method" decision — E13 is where that decision is exercised. — architect (2026-07-10).
- **Reference:** `posthog-js/packages/node/src/extensions/feature-flags/feature-flags.ts` (the local
  evaluator + `FeatureFlagsPoller` + `matchProperty`), `packages/node/src/feature-flag-evaluations.ts`
  (the snapshot the local path also returns), and the `posthog-python` server analog for the Python tree.
- **Fallback must match E12's remote path exactly** — when local eval can't resolve a flag it calls the
  same remote `evaluate` machinery E12 shipped, so a partially-local-partially-remote result is a single
  coherent `FlagSet`. Do not fork a second remote client.
- **The returned `FlagSet` must be indistinguishable from E12's** — a consumer cannot tell whether a
  given flag was served by the local evaluator or the remote round-trip. This is what makes
  "local-vs-remote is adapter-internal" actually true rather than aspirational. Concretely: the local
  path emits the **same neutral `degraded`/`reason` signal** E12 defined (a flag that fell back and
  failed reads identically to a remote failure), and the snapshot's read surface
  (`isEnabled`/`getFlag`/`getPayload`/`getAll`) behaves identically regardless of strategy. — architect
  (2026-07-10, epic-refine).
- **Local eval reads person/group properties straight off `FlagContext`** — E12's locked `FlagContext`
  already carries `personProperties`/`groupProperties`, which is exactly what an in-process
  `matchProperty` needs to evaluate without a round-trip. This is the concrete reason E12's port shape
  holds for E13 with zero seam change: the context the remote path forwards is the same context the
  local path matches against. — architect (2026-07-10).

## Expansion path

- Local eval is the last piece that makes the feature-flags port capability-complete against the
  reference bar. A future self-hosted backend that supports definition-reading gets local eval by
  implementing the same adapter-internal poller/evaluator; one that doesn't simply omits it and stays
  remote-only — both satisfy the unchanged `FeatureFlagPort` (bar A).
