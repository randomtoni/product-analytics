import {
  emptyFlagSet,
  type FeatureFlagPort,
  type FlagSet,
  type TaxonomyShape,
} from 'analytics-kit';

// The silent no-op flag client. Selected by the factory when `key` is absent (or set but with no
// `flagEndpoint`), so "unkeyed/endpointless ⇒ evaluates nothing" is a property of this null object
// rather than a scattered `disabled` flag. `evaluate` resolves the seam's canonical 'unresolved'
// empty snapshot — never a throw — so an unconfigured environment reads flags-off safely (bar B).
// `onChange` fires once with that same empty set (the server once-cardinality) and returns a sound
// no-op unsubscribe. No network is ever touched.
//
// It implements the neutral `FeatureFlagPort` — the null-object PATTERN reused from `QueryNoop`.
// `evaluate` requires no `distinctId`: an env with nothing configured has nothing to evaluate an
// actor against, so the required-distinctId contract is the real client's concern, not the no-op's.
export class FlagNoop<TX extends TaxonomyShape> implements FeatureFlagPort<TX> {
  async evaluate(): Promise<FlagSet<TX>> {
    return emptyFlagSet<TX>();
  }

  onChange(listener: (set: FlagSet<TX>) => void): () => void {
    listener(emptyFlagSet<TX>());
    return () => {};
  }
}
