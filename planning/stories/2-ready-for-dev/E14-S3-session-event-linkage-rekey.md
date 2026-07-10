---
id: E14-S3-session-event-linkage-rekey
epic: E14-SR-session-replay
status: ready-for-dev
area: session-replay
touches: [browser]
depends_on: [E14-S2]
api_impact: additive
---

# E14-S3-session-event-linkage-rekey — Session/event linkage + re-key on rotation

## Why

A recording is only useful if it stitches to the captured events of the same session. This story makes the recorder read the **same** `SessionIdManager` the capture path uses (it does NOT mint its own id), so the recording and the events resolve to one session id — and re-keys the recording when the session id rotates (idle/max-length expiry mid-recording). This is the one hard correctness invariant of the epic: without it, recording and events don't join, and `getReplayId()` returns a fabricated id.

## Scope

### In

- **The recorder reads the shared `SessionIdManager`** (`ts/packages/browser/src/session-id-manager.ts`) — the SAME instance the browser adapter uses to stamp `NeutralEvent.sessionId` (E4-S8). It does NOT construct its own `SessionIdManager` and does NOT mint its own id. `getReplayId()` returns that shared session id (replacing S2's placeholder), as an opaque neutral string.
- **Re-key on session-id rotation** — when the session id rotates (idle/max-length expiry, or reset) mid-recording, the recorder observes the rotation and starts a new recording segment keyed to the new id, so stitching is preserved across the boundary.
  - The pure `SessionIdManager` has no `onSessionId` observer (verified: `checkAndGetSessionId` returns the current/fresh id; the browser adapter already detects rotation by comparing the freshly-stamped id against the last one seen — `browser-adapter.ts:639–663`). **Reuse that existing adapter-side rotation-detection mechanism** — do NOT add a second rotation detector, and do NOT add an `onSessionId` observer to the pure `SessionIdManager`. Hook the recorder's re-key onto the ONE rotation verdict the adapter already computes.
- **`getReplayId()` returns the neutral id, never internals** — never the persisted `SessionTuple`, the `SESSION_ID_KEY` storage key, or a `/replay/{id}` URL. Just the opaque session id string, or `undefined` when inactive.
- **Assert the linkage invariant** — a test proving the recording's session id equals the id stamped on `NeutralEvent.sessionId` for events captured in the same session, and that after a forced rotation the recorder re-keys to the new id (both segments' ids match the events captured in their respective windows).

### Out

- **Snapshot buffering + delivery** — S4. This story wires the id linkage + rotation re-key; S4 owns the buffer, flush cadence, and delivery path (including the **re-decide-on-rotation sampling guard**, which builds on this story's rotation hook).
- **The sampling DECISION mechanism** — S4. This story exposes the rotation signal the sampling guard re-decides on; the decision + flush-guard live in S4.
- **Adding an `onSessionId` observer to `SessionIdManager`** — explicitly out; reuse the adapter's existing rotation-detection verdict (`browser-adapter.ts:639–663`).
- **Any seam change** — the port is frozen (S1).

## Acceptance criteria

- [ ] The recorder reads the shared `SessionIdManager` instance (the same one the capture path stamps `NeutralEvent.sessionId` from) — it mints NO id of its own. A test asserts the recording's session id equals the events' `sessionId` in the same session.
- [ ] On session-id rotation mid-recording, the recorder re-keys to the new id (starts a fresh segment) — a test forces rotation (idle/max-length/reset) and asserts the post-rotation recording id matches the post-rotation events' `sessionId`.
- [ ] The rotation re-key reuses the browser adapter's existing rotation-detection verdict (`browser-adapter.ts:639–663`) — NO second rotation detector, NO `onSessionId` added to the pure `SessionIdManager`.
- [ ] `getReplayId()` returns the opaque neutral session id (or `undefined` when inactive) — never the persisted tuple, the storage key, or a URL.
- [ ] Gates green: `cd ts && pnpm turbo run build test typecheck lint` + `pnpm neutrality-scan`.

## Technical notes

- **The shared session id IS the join key** — architect-locked (epic Notes → "Session/event linkage", 2026-07-10). `SessionIdManager.checkAndGetSessionId` mints/extends the id and the browser adapter stamps `NeutralEvent.sessionId` on every event (E4-S8). The recording must be tagged with the SAME id events carry. **The recorder reads the shared manager — it does NOT mint its own id**; if it did, recording and events would not stitch. That is the one hard correctness invariant.
- **The linkage must be reachable at enrichment, not just via `getReplayId()`** — architect-locked (epic Notes → success criteria, epic-refine 2026-07-10). A read-only `getReplayId()` that nothing propagates would leave events and recording unjoined. Because the browser target already owns `SessionIdManager` and stamps `NeutralEvent.sessionId` (E4-S8), that shared session id resolves BOTH the recording and the captured events to the same id — so replay and events join on the backend. Assert this equality directly.
- **Re-key on rotation is the one moving part** — architect-locked (epic Notes → "Session/event linkage"). Idle/max-length expiry mints a fresh id mid-recording; the recorder must observe rotation and start a new segment against the new id, or stitching breaks across the rotation (the reference does this via `sessionManager.onSessionId`, `session-recording.ts:235`). This is load-bearing, not gold-plating — an explicit acceptance criterion.
- **Reuse the adapter's existing rotation verdict — do NOT add `onSessionId`** — grounded in the real code: `SessionIdManager` is a pure timestamp-driven mint with no observer; the browser adapter ALREADY detects rotation by comparing the freshly-stamped id against the last one seen (`browser-adapter.ts:639–663`, "Adapter-side session-transition verdict … no onSessionId observer on the pure SessionIdManager"). Hook the recorder's re-key onto that ONE mechanism — one rotation-detection mechanism, per the adapter's own comment (`browser-adapter.ts:663`).
- **De-brand reference:** `posthog-js/packages/browser/src/extensions/replay/session-recording.ts:235` (`sessionManager.onSessionId`) — read for what the reference does on rotation, then adapt to the analytics-kit adapter's existing rotation verdict rather than importing the reference's observer pattern.
- **May fold into S2/S4** if the linkage invariant is asserted within the recorder module rather than as a standalone slice — but the two acceptance criteria (id-equals-events, re-key-on-rotation) MUST be proven regardless. Kept a standalone story because re-key-on-rotation is the epic's one hard correctness invariant and deserves an explicit proof.
- No architect consult needed — every decision above is pre-resolved in the epic `## Notes`.

## Shipped
