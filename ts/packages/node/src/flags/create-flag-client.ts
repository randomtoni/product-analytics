import type {
  DefaultTaxonomyShape,
  FeatureFlagPort,
  ShapeOf,
  Taxonomy,
  TaxonomyDecl,
} from 'analytics-kit';
import type { FlagClientConfig } from './config';
import { FlagNoop } from './flag-noop';
import { HttpFlagAdapter } from './http-flag-adapter';

export function createFlagClient<const T extends TaxonomyDecl>(
  config: FlagClientConfig & { taxonomy: Taxonomy<T> }
): FeatureFlagPort<ShapeOf<T>>;
export function createFlagClient(
  config: FlagClientConfig
): FeatureFlagPort<DefaultTaxonomyShape>;
export function createFlagClient(
  config: FlagClientConfig
): FeatureFlagPort<DefaultTaxonomyShape> {
  // Unkeyed ⇒ a silent no-op flag client: the null object evaluates nothing, never constructs an
  // adapter or touches the network, and `evaluate` resolves the seam's 'unresolved' empty snapshot
  // (bar B — config-only adoption, an unconfigured environment reads flags-off). The `key`
  // authenticates the flag round-trip in-body; without it there is no request to make.
  if (config.key === undefined || config.key === '') {
    return new FlagNoop<DefaultTaxonomyShape>();
  }
  if (config.flagEndpoint === undefined || config.flagEndpoint.trim() === '') {
    console.warn(
      'analytics: a key is set but no flagEndpoint is configured; a flag evaluation has nowhere to go. Returning a no-op flag client. Set flagEndpoint.'
    );
    return new FlagNoop<DefaultTaxonomyShape>();
  }
  // Keyed + endpointed ⇒ the real remote flag adapter. It reads `key`/`flagEndpoint`/`bootstrap`/
  // `fetch` off `config`, maps each neutral `evaluate` context onto the adapter-internal wire, and
  // runs one independent round-trip per call (a stateless server has no shared actor).
  return new HttpFlagAdapter<DefaultTaxonomyShape>({
    key: config.key,
    flagEndpoint: config.flagEndpoint,
    bootstrap: config.bootstrap,
    fetch: config.fetch ?? fetch,
  });
}
