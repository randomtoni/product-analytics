import type {
  DefaultTaxonomyShape,
  FeatureFlagPort,
  ShapeOf,
  Taxonomy,
  TaxonomyDecl,
  TaxonomyShape,
} from '@randomtoni/analytics-kit';
import type { FlagClientConfig } from './config';
import { FlagNoop } from './flag-noop';
import { HttpFlagAdapter, type LocalEvalCapability } from './http-flag-adapter';
import { DefinitionPoller } from './local';
// S1's lowering + seed-time validator are INTERNAL — imported by explicit module path (not from the
// `./local` barrel, which does not re-export them). The consumer authors the neutral `FeatureFlagDefinition`.
import { lowerDefinitions } from './local/neutral-definition';
import { validateDefinitions } from './local/validate-definitions';

// The default definition poll interval (ms) when the config omits `pollInterval`.
const DEFAULT_POLL_INTERVAL_MS = 30_000;

// The node flag client's return type: the neutral FeatureFlagPort plus a node-local `stop()` that
// releases the background definition poller (a no-op on the remote-only / no-op branches). `stop()`
// lives HERE, on the node client, never on the neutral `FeatureFlagPort` seam — a short-lived server
// process (CLI/cron) needs to release the poller so it can exit; a browser consumer has no such verb.
export type NodeFlagClient<TX extends TaxonomyShape> = FeatureFlagPort<TX> & { stop(): void };

export function createFlagClient<const T extends TaxonomyDecl>(
  config: FlagClientConfig & { taxonomy: Taxonomy<T> }
): NodeFlagClient<ShapeOf<T>>;
export function createFlagClient(
  config: FlagClientConfig
): NodeFlagClient<DefaultTaxonomyShape>;
export function createFlagClient(
  config: FlagClientConfig
): NodeFlagClient<DefaultTaxonomyShape> {
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

// Build the local-eval capability when the config selects it. Two selectors, in this order:
//   1. STATIC definitions (the fully-local self-host default) — `staticDefinitions` present ⇒ a
//      SEEDED poller carrying the lowered snapshot, with NO definitions endpoint / privileged
//      credential / fetch. The definition source is config, so the client makes zero definition
//      fetches. Validated loudly here (throws at construction on a malformed set).
//   2. The definitions endpoint + privileged credential (the poller-fetch path) — unchanged.
// Absent both ⇒ undefined (remote-only). A local capability from EITHER selector is a real route, so
// the factory's "keyed but no route ⇒ no-op" guard does not swallow a static-defs local-only config.
// The effective local-only posture follows the reference default: `onlyEvaluateLocally ?? false`.
function buildLocalCapability(
  config: FlagClientConfig,
  doFetch: typeof fetch
): LocalEvalCapability | undefined {
  const staticDefinitions = config.staticDefinitions;
  if (staticDefinitions !== undefined) {
    // An EMPTY static set is still a valid, non-throwing seed (it lowers to an empty snapshot), but
    // its poller is permanently not-ready, so every eval degrades silently to the unresolved set —
    // almost always an accidental empty config. Warn (dev-time only) so it is observable; a non-empty
    // set stays silent.
    if (staticDefinitions.length === 0) {
      console.warn(
        'analytics: staticDefinitions is empty; the local flag client seeds an empty definition set and every evaluation degrades to the unresolved (flags-off) set. Supply at least one definition, or omit staticDefinitions.'
      );
    }
    // Validate at the input boundary so a malformed static set fails LOUDLY at client construction
    // (config-layer `Error`), not lazily at first eval. Then lower to the wire snapshot and seed a
    // poller that structurally cannot fetch — the endpoint/credential are not supplied to it.
    validateDefinitions(staticDefinitions);
    const poller = DefinitionPoller.seeded(lowerDefinitions(staticDefinitions));
    return {
      poller,
      onlyLocally: config.onlyEvaluateLocally ?? false,
    };
  }

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
    onlyLocally: config.onlyEvaluateLocally ?? false,
  };
}
