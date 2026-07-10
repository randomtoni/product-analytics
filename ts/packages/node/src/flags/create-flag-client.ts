import type {
  DefaultTaxonomyShape,
  FeatureFlagPort,
  ShapeOf,
  Taxonomy,
  TaxonomyDecl,
} from 'analytics-kit';
import type { FlagClientConfig } from './config';
import { FlagNoop } from './flag-noop';
import { HttpFlagAdapter, type LocalEvalCapability } from './http-flag-adapter';
import { DefinitionPoller } from './local';

// The default definition poll interval (ms) when the config omits `pollInterval`.
const DEFAULT_POLL_INTERVAL_MS = 30_000;

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

  const doFetch = config.fetch ?? fetch;
  const local = buildLocalCapability(config, doFetch);
  const hasRemote = config.flagEndpoint !== undefined && config.flagEndpoint.trim() !== '';

  // A key with NO route anywhere — neither a remote flagEndpoint nor a local definitions endpoint —
  // has nowhere to evaluate. Warn once and no-op (bar B: an under-configured environment reads
  // flags-off rather than crashing). A local-capable config is a real route even without a remote
  // flagEndpoint (the local-only posture), so it does NOT fall through here.
  if (!hasRemote && local === undefined) {
    console.warn(
      'analytics: a key is set but no flagEndpoint or definitionsEndpoint is configured; a flag evaluation has nowhere to go. Returning a no-op flag client. Set flagEndpoint (remote) and/or definitionsEndpoint (local).'
    );
    return new FlagNoop<DefaultTaxonomyShape>();
  }

  // Keyed with at least one route ⇒ the real flag adapter. It reads `key`/`flagEndpoint`/`bootstrap`/
  // `fetch` off `config` for the remote path, and — when a definitions endpoint + privileged
  // credential are present — carries the S1 poller/evaluator for a local-first strategy behind the
  // unchanged `evaluate`. Local-capability is ADDITIVE: absent ⇒ remote-only exactly as E12 shipped.
  return new HttpFlagAdapter<DefaultTaxonomyShape>({
    key: config.key,
    flagEndpoint: config.flagEndpoint,
    bootstrap: config.bootstrap,
    fetch: doFetch,
    local,
  });
}

// Build the local-eval capability when the config selects it: a definitions endpoint + a privileged
// definition-reading credential. Absent ⇒ undefined (remote-only). The effective local-only posture
// follows the reference default: `onlyEvaluateLocally ?? strictLocalEvaluation ?? false`.
function buildLocalCapability(
  config: FlagClientConfig,
  doFetch: typeof fetch
): LocalEvalCapability | undefined {
  const endpoint = config.definitionsEndpoint;
  const definitionsKey = config.definitionsKey;
  if (
    endpoint === undefined ||
    endpoint.trim() === '' ||
    definitionsKey === undefined ||
    definitionsKey === ''
  ) {
    return undefined;
  }
  const poller = new DefinitionPoller({
    definitionsEndpoint: endpoint,
    definitionsKey,
    token: config.key as string,
    pollIntervalMs: config.pollInterval ?? DEFAULT_POLL_INTERVAL_MS,
    fetch: doFetch,
  });
  return {
    poller,
    onlyLocally: config.onlyEvaluateLocally ?? config.strictLocalEvaluation ?? false,
  };
}
