# Roadmap — analytics-kit

Last updated: 2026-07-09 — Python-parity cycle opened as NOW; feature-flags promoted to UPCOMING

## Status

Pre-1.0. Two cycles complete in **TypeScript** and archived: the vendor-neutral **`core`** seam,
then the **R1 targets** cycle (browser · node · React targets + example consumer + adoption audit).
The TS lib is capability-complete against the BRIEF contract, with both acceptance bars and
vendor-neutrality gated as standing CI checks. On 2026-07-09 the repo split into a polyglot layout
([`ts/`](../ts/) shipped, [`python/`](../python/) scaffolded); the third cycle — **Python parity** —
is NOW, in flight once its epics land. Closed cycles archive their epics to
[`epics/done/`](epics/done/); the narrative of what each established lives in
[`planning/HISTORY.md`](HISTORY.md).

## Sequencing

NOW holds the epics committed for the current build push; **`/implement-epics all` builds every NOW
epic**, in dependency order driven by each epic's `blocked_by` graph. Epics are the unit of work,
not grouped into area-cycles. Prioritization is measured against the SOTA / `posthog-js`-capability
bar, not consumer pull.

## NOW

**Python parity** — a full Python implementation of the vendor-neutral library under
[`python/`](../python/) (scaffolded), built to capability parity with the shipped TS lib. The parity
rule governs the whole cycle: **every capability the TS surface exposes must be reachable in
Python**, adapted idiomatically and **server-shaped** — a plain client plus framework bindings, with
no browser/DOM target (persistence, autocapture, pageviews and session replay have no server analog
and are out of scope here).

The **shipped [`ts/`](../ts/) tree is the contract reference** the port ports *to*: the Python seam
mirrors it capability-for-capability, only the expression differs. Same seam, idiomatic per language
— provider contract and adapter interface as `Protocol`s, **Pydantic at the genuine boundaries**,
the typed-taxonomy mechanism, the consumer-supplied payload allowlist, and the config-selected
factory. The PostHog-compatible target is **de-branded from `posthog-python`** (the server-SDK
analog, cloned beside `posthog-js/` at the repo root), copying only what's needed and neutralizing
it — no vendor name reaches the Python surface. A **Python analog of the neutrality scan** lands in
the cycle's audit epic as the standing zero-vendor gate, mirroring `ts/scripts/neutrality-scan.ts`.

The shape mirrors the TS build: seam → server capture → query client → framework bindings → example
consumer → adoption + neutrality audit.

_Epics are being drafted (architect-consulted) — the epic list fills in at the next `/roadmap
promote` step._

## UPCOMING

**feature-flags** — implement the declared-but-unimplemented `FeatureFlagPort` (evaluation,
bootstrap, local/server-side eval, flag payloads) behind the vendor-neutral seam, across **both
language trees**. Feature flags are core, cross-platform surface for every mature analytics SDK — in
the `posthog-js` reference they live in `core` + `browser` + `node`, so the capability is inherently
server-shaped as well as browser-shaped and advances the TS *and* Python surfaces together. The port
is already declared in the shipped seam, so this finishes a stubbed contract rather than widening the
charter; it lands additively. The neutral interface is defined once and satisfied by each target's
adapter, keeping provider-swap and config-only-adoption intact.

## LATER

- **session-replay** — implement the declared-but-unimplemented `SessionReplayPort`. Browser-shaped
  (DOM capture); TS-only in practice, with no server analog — advances a narrower slice of the
  surface than feature-flags, which is why it sequences after.

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
