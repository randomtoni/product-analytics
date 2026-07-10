import type { FlagsConfig } from './create-analytics';
import { emptyFlagSet } from './ports';
import type { FlagReason, FlagSet, FlagValue } from './ports';
import type { TaxonomyShape } from './taxonomy';

// The neutral resolved-flag data an adapter carries between its own wire parsing and the FlagSet it
// hands back: the flag→value map, the sibling payload map, and the snapshot-uniform degradation
// signal (`reason`/`degraded`). Every backend adapter parses ITS OWN wire response down to this
// shape, then wraps it with the one canonical `buildFlagSet`. No wire/transport vocabulary lives
// here — this is the read-contract, not an envelope. Renamed from the adapters' local `Snapshot`
// to disambiguate the neutral shape from an adapter's own cache type.
export interface FlagSnapshot {
  flags: Record<string, FlagValue>;
  payloads: Record<string, unknown>;
  reason: FlagReason;
  degraded: boolean;
}

// The ONE canonical FlagSet read-contract: wrap a resolved FlagSnapshot in an immutable FlagSet
// whose reads are pure synchronous lookups off the frozen backing maps. `reason` reports the same
// snapshot-level value for every present key; `isEnabled` collapses a missing flag to false while
// `getFlag`/`getPayload` distinguish missing (undefined) from disabled (false). A degraded-EMPTY
// snapshot (nothing resolved) presents as the seam's canonical `emptyFlagSet`, so `reason(key)`
// reports 'unresolved' for every key — matching every adapter and the null-object. This is a
// FlagSet CONSTRUCTOR, seam-appropriate exactly like `emptyFlagSet`; the taxonomy generic carries
// so a typed consumer's `getFlag`/`getPayload` reads narrow.
export function buildFlagSet<TX extends TaxonomyShape>(snapshot: FlagSnapshot): FlagSet<TX> {
  const { flags, payloads, reason, degraded } = snapshot;
  if (Object.keys(flags).length === 0 && Object.keys(payloads).length === 0 && degraded) {
    return emptyFlagSet<TX>();
  }
  return Object.freeze({
    isEnabled: (key: string): boolean => flags[key] !== undefined && flags[key] !== false,
    getFlag: (key: string): FlagValue | undefined => flags[key],
    getPayload: (key: string): unknown => payloads[key],
    getAll: (): Record<string, FlagValue> => ({ ...flags }),
    degraded,
    reason: (key: string): FlagReason | undefined =>
      flags[key] !== undefined || payloads[key] !== undefined ? reason : undefined,
  }) as FlagSet<TX>;
}

// Seed a snapshot from config bootstrap: a resolved-shaped snapshot read 'bootstrap' until a fetch
// or round-trip replaces it. undefined when no bootstrap is supplied (the cache starts empty). Not
// degraded — bootstrap is a real, intentional set, not a failed eval. Uses only neutral config, so
// it stays seam-safe (no wire vocabulary). An adapter restamps the reason (e.g. to 'stale') when it
// actually serves the seed after a failed refresh.
export function seedBootstrap(bootstrap: FlagsConfig['bootstrap']): FlagSnapshot | undefined {
  if (bootstrap === undefined) {
    return undefined;
  }
  return {
    flags: { ...(bootstrap.flags ?? {}) },
    payloads: { ...(bootstrap.payloads ?? {}) },
    reason: 'bootstrap',
    degraded: false,
  };
}
