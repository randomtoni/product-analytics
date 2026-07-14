---
id: E21-S1-python-driver-write-path-fix
epic: E21-OBS-protocol-neutrality-gate
status: ready-for-dev
area: observability
touches: [adapters, query, node]
depends_on: []
api_impact: additive
---

# E21-S1-python-driver-write-path-fix — Python default-driver write-path fix (the recorded MUST-FIX)

## Why

The Python default warehouse driver crashes on the E19 receiver's non-RETURNING write, so the
Python side of the E1 end-to-end loop cannot run at all until it is fixed. This is the recorded
MUST-FIX and it goes first — it unblocks the Python half of E21-S3.

## Scope

### In

- Fix `python/src/analytics_kit/query/default_db_execute.py` `_result_from_cursor`: add an early
  return of an empty `DbExecuteResult(rows=[], columns=[])` when `cursor.description is None`,
  **before** the `cursor.fetchall()` call. This is the one-line guard the epic records.
- Add a real-driver write **unit test** in the Python tree (marked `needs_postgres`, per S3's tier):
  construct the real `DefaultDbExecute` against a real Postgres, execute a non-RETURNING
  `INSERT … ON CONFLICT (uuid) DO NOTHING`, assert it returns `DbExecuteResult(rows=[], columns=[])`
  and does **not** raise. This is the real-driver conformance the fake-backed E19 tests structurally
  cannot cover.
- Verify (no code change expected) the TS `pg` path already conforms — `toResult` in
  `ts/packages/node/src/query/default-db-execute.ts` returns `{ rows: [], columns: [] }` from `pg`'s
  empty write result. If it already conforms, record that in `Shipped` and touch no TS src.

### Out

- The `needs_postgres` marker / test-tier plumbing itself — that is S3's job (this story's unit test
  is *decorated* with the marker but does not define the tier). If S1 lands before S3's plumbing, gate
  the test with a plain `skipif(DATABASE_URL is None)` so it is inert until S3 wires the tier; S3
  finalizes the marker.
- The end-to-end loop, the receiver integration, the zero-egress assertion — E21-S3.
- Any change to the `DbExecute` seam, the fake, or the receiver — the fix is strictly inside the
  PostgreSQL default driver, behind the frozen seam.

## Acceptance criteria

- [ ] `_result_from_cursor` returns `DbExecuteResult(rows=[], columns=[])` when
      `cursor.description is None`, without calling `cursor.fetchall()`.
- [ ] A real-driver write test proves a non-RETURNING `INSERT … ON CONFLICT DO NOTHING` returns the
      empty result and does not raise `ProgrammingError`.
- [ ] The Python and TS drivers now BOTH return `{ rows: [], columns: [] }` on a non-RETURNING write
      (parity end-state); TS confirmed conformant with no change, or the delta is recorded.
- [ ] The existing fake-backed E17–E20 Python tests stay green (the fix is additive to the write path).
- [ ] Vendor-neutral: the fix names no vendor and no driver in any consumer-observable surface; it is
      adapter-internal driver mechanics behind the `DbExecute` seam.

## Technical notes

The bug and the guard are locked by the epic `## Development prerequisites` (MUST-FIX) and confirmed
verbatim by the architect against the shipped src.

- **The bug — confirmed real, and the write path reaches it.** `_result_from_cursor`
  (`python/src/analytics_kit/query/default_db_execute.py:43-49`) already guards `None` for the
  columns line (`cursor.description or []`) but calls `cursor.fetchall()` **unconditionally** at
  line 48. On the E19 receiver's `INSERT … ON CONFLICT (uuid) DO NOTHING` (a non-RETURNING write),
  psycopg3 sets `cursor.description = None` and `fetchall()` raises
  `ProgrammingError("the last operation didn't produce a result")`. The write path that reaches it:
  `Receiver.handle` → `self._db_execute.execute(sql, params)` (`python/src/analytics_kit/receiver/receiver.py:222`)
  → `DefaultDbExecute.execute` (`default_db_execute.py:66-75`) → `_result_from_cursor(cursor)` at
  line 73, which runs *before returning* — so the bug fires even though the receiver discards the
  result. It is unreachable from any E17–E20 test (all fake-backed — `python/tests/db_execute_fakes.py`
  returns a canned result, never a live cursor), which is why it survived to E21.
  — architect (2026-07-14)
- **The one-line guard.** Early return at the top of `_result_from_cursor`, before line 48:
  return `DbExecuteResult(rows=[], columns=[])` when `cursor.description is None`. The `_CursorLike`
  Protocol already types `description: Sequence[...] | None`, so this is type-clean. Once the early
  return handles `None`, the `or []` on the columns line is redundant-but-harmless — simplifying it is
  a reviewer nicety, not part of the fix. — architect (2026-07-14)
- **TS already conforms — verify, do not change.** `toResult`
  (`ts/packages/node/src/query/default-db-execute.ts:46-52`) maps `pg`'s `{ rows: [], fields: [] }`
  (what node-postgres returns on a non-RETURNING write) to `{ rows: [], columns: [] }` — no
  `fetchall()`-equivalent to throw on, no cursor-description branch to get wrong. The shape matches
  the existing `EMPTY_RESULT` fixture at `ts/packages/node/src/query/db-execute.fixtures.ts:23`
  (`{ rows: [], columns: [] }`). Parity end-state: both drivers return the empty result on a
  non-RETURNING write. — architect (2026-07-14)
- **Test-tier marker.** The real-driver write test needs a real Postgres, so it belongs to S3's
  `needs_postgres` tier (Python: `@pytest.mark.needs_postgres` + `skipif(DATABASE_URL is None)`). If
  S1 lands ahead of S3, gate it with `skipif` alone and let S3 register the marker in
  `python/pyproject.toml`. Postgres provisioning (Docker `postgres:16`) is S3's setup. — architect (2026-07-14)

## Shipped

<!-- Filled by /implement-epics on move to 5-done. -->
