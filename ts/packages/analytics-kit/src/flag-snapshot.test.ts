import { expect, test } from 'vitest';
import {
  buildFlagSet as ExportedBuildFlagSet,
  seedBootstrap as ExportedSeedBootstrap,
} from './index';
import { buildFlagSet, seedBootstrap, type FlagSnapshot } from './flag-snapshot';
import { emptyFlagSet } from './ports';

// The shared read-contract module: the ONE canonical Snapshot→FlagSet constructor + the
// config→snapshot seeder, lifted from the byte-duplicated browser/node adapters (F2). These
// tests pin the contract every adapter now inherits, so a change to one can't silently diverge.

test('buildFlagSet + seedBootstrap are re-exported from the package entrypoint', () => {
  expect(ExportedBuildFlagSet).toBe(buildFlagSet);
  expect(ExportedSeedBootstrap).toBe(seedBootstrap);
});

test('buildFlagSet wraps a resolved snapshot: enabled/variant/payload reads and snapshot-uniform reason', () => {
  const snapshot: FlagSnapshot = {
    flags: { dark_mode: true, checkout: 'a', off: false },
    payloads: { checkout: { discount: 10 } },
    reason: 'resolved',
    degraded: false,
  };
  const set = buildFlagSet(snapshot);

  expect(set.isEnabled('dark_mode')).toBe(true);
  expect(set.isEnabled('checkout')).toBe(true);
  // A `false` flag is disabled; a missing flag is also disabled.
  expect(set.isEnabled('off')).toBe(false);
  expect(set.isEnabled('missing')).toBe(false);

  // getFlag/getPayload distinguish missing (undefined) from disabled (false).
  expect(set.getFlag('checkout')).toBe('a');
  expect(set.getFlag('off')).toBe(false);
  expect(set.getFlag('missing')).toBeUndefined();
  expect(set.getPayload('checkout')).toEqual({ discount: 10 });
  expect(set.getPayload('missing')).toBeUndefined();

  expect(set.getAll()).toEqual({ dark_mode: true, checkout: 'a', off: false });
  expect(set.degraded).toBe(false);
  // reason is snapshot-uniform for present keys; a payload-only key still reports it.
  expect(set.reason('dark_mode')).toBe('resolved');
  expect(set.reason('off')).toBe('resolved');
  expect(set.reason('missing')).toBeUndefined();
});

test('buildFlagSet returns a FROZEN set', () => {
  const set = buildFlagSet({ flags: { a: true }, payloads: {}, reason: 'resolved', degraded: false });
  expect(Object.isFrozen(set)).toBe(true);
});

test('buildFlagSet: a degraded-EMPTY snapshot collapses to the canonical emptyFlagSet (reason unresolved)', () => {
  const set = buildFlagSet({ flags: {}, payloads: {}, reason: 'unresolved', degraded: true });
  const empty = emptyFlagSet();

  // Structurally the null-object: every read collapses, reason('anything') is 'unresolved'.
  expect(set.degraded).toBe(true);
  expect(set.reason('anything')).toBe('unresolved');
  expect(set.isEnabled('anything')).toBe(false);
  expect(set.getFlag('anything')).toBeUndefined();
  expect(set.getAll()).toEqual({});
  // Same observable contract as the seam's emptyFlagSet.
  expect(set.reason('x')).toBe(empty.reason('x'));
  expect(set.getAll()).toEqual(empty.getAll());
});

test('buildFlagSet: a NON-degraded empty snapshot stays a real (non-unresolved) set', () => {
  // The guard only fires when BOTH empty AND degraded. A non-degraded empty snapshot keeps
  // per-key reason gating: absent keys read undefined, NOT 'unresolved'.
  const set = buildFlagSet({ flags: {}, payloads: {}, reason: 'resolved', degraded: false });
  expect(set.degraded).toBe(false);
  expect(set.reason('anything')).toBeUndefined();
});

test('buildFlagSet: a degraded but NON-empty snapshot keeps its reads and per-key reason', () => {
  // The guard is empty-AND-degraded — a stale (degraded) snapshot with data is a real set.
  const set = buildFlagSet({ flags: { a: true }, payloads: {}, reason: 'stale', degraded: true });
  expect(set.degraded).toBe(true);
  expect(set.isEnabled('a')).toBe(true);
  expect(set.reason('a')).toBe('stale');
  expect(set.reason('missing')).toBeUndefined();
});

test('seedBootstrap: undefined bootstrap seeds nothing', () => {
  expect(seedBootstrap(undefined)).toBeUndefined();
});

test('seedBootstrap: a config bootstrap becomes a non-degraded bootstrap snapshot (defensively copied)', () => {
  const flags = { dark_mode: true };
  const payloads = { dark_mode: { color: 'black' } };
  const snapshot = seedBootstrap({ flags, payloads });

  expect(snapshot).toEqual({ flags, payloads, reason: 'bootstrap', degraded: false });
  // Defensive copy — mutating the source config must not leak into the snapshot.
  flags.dark_mode = false;
  expect(snapshot?.flags.dark_mode).toBe(true);
});

test('seedBootstrap: a bootstrap with absent flags/payloads defaults to empty maps', () => {
  const snapshot = seedBootstrap({});
  expect(snapshot).toEqual({ flags: {}, payloads: {}, reason: 'bootstrap', degraded: false });
});
