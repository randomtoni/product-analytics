import type { NeutralProperties } from './neutral-event';
import type { DefaultTaxonomyShape, TaxonomyShape } from './taxonomy';

// The session-replay capability is still a sketch — its method surface stays loose until a
// real adapter first implements one (E14). Always undefined on the seam in this release.
export interface SessionReplayPort {
  start(): void;
}

// A resolved flag's value: a variant string, or a plain on/off boolean.
export type FlagValue = string | boolean;

// The consumer-observable state of a resolved flag read — the neutral degradation signal.
// Named by state, never by any vendor eval-quality field: 'resolved' = evaluated fresh from
// the round-trip/fetch; 'bootstrap' = served from config bootstrap before any fetch resolved;
// 'stale' = a prior cached set served after a failed refresh; 'unresolved' = no value
// available (failed with no fallback). Frozen here — the three adapters bind to this one union.
export type FlagReason = 'resolved' | 'bootstrap' | 'stale' | 'unresolved';

// The one neutral evaluation input: who is being evaluated and what properties describe them.
// `distinctId` is optional on the TYPE; a server adapter enforces its presence (no ambient
// actor), a browser adapter fills it from current identity. Control knobs (refresh) do NOT
// live here — they ride `FlagEvaluateOptions`, so this stays pure "who + what properties".
export interface FlagContext {
  distinctId?: string;
  groups?: Record<string, string>;
  personProperties?: NeutralProperties;
  groupProperties?: Record<string, NeutralProperties>;
  flagKeys?: readonly string[];
}

// Call-time control knobs for `evaluate`, separate from the evaluation input. `refresh` folds
// the browser's `reload` into `evaluate`: a caller forcing a re-fetch passes `{ refresh: true }`
// (and may ignore the returned promise for a fire-and-forget refresh). No separate `reload`.
export interface FlagEvaluateOptions {
  refresh?: boolean;
}

// An immutable resolved snapshot, read synchronously off the async `evaluate` boundary. The
// reads narrow against the taxonomy `flags` slot: `getFlag` to declared variants (| boolean),
// `getPayload` to the declared payload shape. `degraded`/`reason` are the neutral degradation
// signal — a consumer distinguishes "flag is off" from "eval failed / was partial". Vendor
// eval-quality metadata never reaches this type.
export interface FlagSet<TX extends TaxonomyShape = DefaultTaxonomyShape> {
  isEnabled(key: string): boolean;
  getFlag<K extends keyof TX['flags'] & string>(key: K): VariantOf<TX, K> | undefined;
  getFlag(key: string): FlagValue | undefined;
  getPayload<K extends keyof TX['flags'] & string>(key: K): TX['flags'][K]['payload'] | undefined;
  getPayload(key: string): unknown;
  getAll(): Record<string, FlagValue>;
  degraded: boolean;
  reason(key: string): FlagReason | undefined;
}

// The value type a declared flag's `getFlag` narrows to: its declared variant union OR
// `boolean` (a variant flag can still resolve on/off). A flag with no declared variants
// (`variants: never`) collapses to plain `boolean`.
type VariantOf<TX extends TaxonomyShape, K extends keyof TX['flags']> =
  | TX['flags'][K]['variants']
  | boolean;

// The neutral feature-flag capability port: one async load-bearing method resolving an
// immutable `FlagSet` snapshot, plus a change-listener. `evaluate` is async at the boundary
// (a browser first-load, a server round-trip, and a future self-hosted HTTP adapter are all
// honest behind it) and sync off the returned snapshot. `onChange` fires once with the
// resolved set on server adapters and re-fires on reload in the browser — uniform signature,
// different cardinality. Generic over the taxonomy shape, defaulting to `DefaultTaxonomyShape`
// so untyped consumers are unaffected (mirrors `AnalyticsProvider<TX>`).
export interface FeatureFlagPort<TX extends TaxonomyShape = DefaultTaxonomyShape> {
  evaluate(context?: FlagContext, options?: FlagEvaluateOptions): Promise<FlagSet<TX>>;
  onChange(listener: (set: FlagSet<TX>) => void): () => void;
}

// The canonical "nothing-resolved" snapshot — a real, structurally-complete `FlagSet` a
// consumer can call safely (never a bare `undefined`/`{}` that crashes `.isEnabled(...)`).
// The `NoopAdapter` null-object precedent applied to `FlagSet`: it inhabits the contract with
// `degraded:true`/`reason:'unresolved'`/empty reads. A factory (not a const) because
// `FlagSet<TX>` is generic — it returns the correctly-typed empty per taxonomy. Consumed by the
// browser adapter's failed-with-no-fallback fallback and by the React binding's absent-`flags`
// case, so neither forks its own empty snapshot.
export function emptyFlagSet<TX extends TaxonomyShape = DefaultTaxonomyShape>(): FlagSet<TX> {
  return Object.freeze({
    isEnabled: () => false,
    getFlag: () => undefined,
    getPayload: () => undefined,
    getAll: () => ({}),
    degraded: true,
    reason: () => 'unresolved',
  }) as FlagSet<TX>;
}
