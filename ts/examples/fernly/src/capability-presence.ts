// E11-S4 capability-presence gate — the staleness tripwire that keeps the
// capability-completeness audit (planning/audit/capability-completeness.md) HONEST.
//
// It asserts, at TYPECHECK time, that the frozen neutral surface is ACTUALLY present + shaped on
// the BUILT `dist` type exports. A rename / drop / signature-change of any frozen member FAILS
// `tsc --noEmit` here — this file compiles against the packages' PUBLISHED entries (imported by
// package name → resolves each package's `dist/index.d.ts`, NOT its `src`), and `turbo run
// typecheck` runs `dependsOn ^build`, so the imports see exactly what tsup shipped.
//
// PRESENCE + SHAPE only. This is NOT a semantic-equivalence check — meaning stays in the prose
// audit + reviewer judgment. `AnalyticsProvider` / `NodeAnalytics` / `AnalyticsQueryClient` are
// TYPE-ONLY exports (interfaces, no runtime value), so member presence is asserted via `keyof`
// equality at typecheck time — NOT a runtime `Object.keys` inspection (an interface has no
// runtime object). Value exports (createAnalytics, NoopAdapter, …) get a separate RUNTIME
// presence check in `capability-presence.test.ts`.

import type {
  DefaultTaxonomyShape,
  AnalyticsProvider,
  FeatureFlagPort,
  FlagSet,
  QueryResult,
} from 'analytics-kit';
import type { NodeAnalytics, AnalyticsQueryClient } from '@analytics-kit/node';

// Invariant mutual-assignability equality: resolves to `true` ONLY when A and B are the exact same
// key union (order-independent). The `(<T>() => …)` form is the strict "exact equality" primitive;
// a plain bidirectional `extends` can pass on index-signature edge cases, this cannot.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

type IsCallable<T> = T extends (...args: never[]) => unknown ? true : false;

// ── Layer 1 — exact key-set equality (the rename/drop/ADD tripwire) ──────────────────────────
//
// The frozen contracts as ORDER-INDEPENDENT union literals. A member renamed, dropped, or ADDED
// changes `keyof` → the corresponding `Equals<…>` resolves to `false` → the `true` assignment
// below FAILS typecheck. `flags`/`replay` are optional (`flags?`/`replay?`) but `keyof` erases the
// `?` and yields the bare key names, so this asserts the INTERFACE DECLARES them — NOT that any
// instance carries them (declared-only this release, by design).

// Frozen-15: 13 methods + flags? + replay?.
type FrozenProviderMembers =
  | 'track'
  | 'identify'
  | 'page'
  | 'group'
  | 'reset'
  | 'setTraits'
  | 'register'
  | 'unregister'
  | 'optIn'
  | 'optOut'
  | 'hasOptedOut'
  | 'flush'
  | 'shutdown'
  | 'flags'
  | 'replay';

// The 3 BRIEF node verbs + lifecycle. NodeAnalytics/AnalyticsQueryClient have no default type arg,
// so a concrete shape is supplied to take `keyof`.
type FrozenNodeMembers = 'capture' | 'setTraits' | 'setGroupTraits' | 'flush' | 'shutdown';

// The 5 query methods.
type FrozenQueryMembers = 'funnel' | 'retention' | 'trend' | 'uniqueCount' | 'rawQuery';

// The 2 feature-flag PORT methods (E12-S1 decided this shape). The FlagSet snapshot reads
// (isEnabled/getFlag/getPayload/getAll/degraded/reason) are members of the RETURNED FlagSet type,
// NOT of the port — so they are pinned separately (the evaluate-returns-Promise<FlagSet> pin
// below), never added here. The browser/seam `flags?` slot presence is already covered by
// FrozenProviderMembers; the node flag client is a standalone `createFlagClient` factory (NOT a
// NodeAnalytics member — FrozenNodeMembers stays capture/setTraits/setGroupTraits/flush/shutdown).
type FrozenFlagMembers = 'evaluate' | 'onChange';

// ── Layer 2 — targeted return-category pins (the sync↔async / non-fn regression tripwire) ─────
//
// NOT full-signature pinning (that re-encodes the taxonomy generics and is brittle on cosmetics).
// Only the high-signal return categories a real API break would flip: the async verbs stay
// `Promise<void>`, `hasOptedOut` stays `boolean`, the query methods stay `Promise<QueryResult>`.
// Everything else is pinned only as "still a callable member" — catches a member widened to a
// non-function without asserting its (generic) argument shape.

type Assertions = {
  // Layer 1 — presence.
  providerKeys: Equals<keyof AnalyticsProvider, FrozenProviderMembers>;
  nodeKeys: Equals<keyof NodeAnalytics<DefaultTaxonomyShape>, FrozenNodeMembers>;
  queryKeys: Equals<keyof AnalyticsQueryClient<DefaultTaxonomyShape>, FrozenQueryMembers>;
  flagPortKeys: Equals<keyof FeatureFlagPort<DefaultTaxonomyShape>, FrozenFlagMembers>;

  // Layer 2 — provider members stay callable; async verbs stay Promise<void>; query verb is boolean.
  trackCallable: IsCallable<AnalyticsProvider['track']>;
  identifyCallable: IsCallable<AnalyticsProvider['identify']>;
  pageCallable: IsCallable<AnalyticsProvider['page']>;
  groupCallable: IsCallable<AnalyticsProvider['group']>;
  resetCallable: IsCallable<AnalyticsProvider['reset']>;
  setTraitsCallable: IsCallable<AnalyticsProvider['setTraits']>;
  registerCallable: IsCallable<AnalyticsProvider['register']>;
  unregisterCallable: IsCallable<AnalyticsProvider['unregister']>;
  optInCallable: IsCallable<AnalyticsProvider['optIn']>;
  optOutCallable: IsCallable<AnalyticsProvider['optOut']>;
  hasOptedOutBoolean: AnalyticsProvider['hasOptedOut'] extends () => boolean ? true : false;
  providerFlushPromise: AnalyticsProvider['flush'] extends () => Promise<void> ? true : false;
  providerShutdownPromise: AnalyticsProvider['shutdown'] extends () => Promise<void> ? true : false;

  // Layer 2 — node verbs stay callable; async verbs stay Promise<void>.
  nodeCaptureCallable: IsCallable<NodeAnalytics<DefaultTaxonomyShape>['capture']>;
  nodeSetTraitsCallable: IsCallable<NodeAnalytics<DefaultTaxonomyShape>['setTraits']>;
  nodeSetGroupTraitsCallable: IsCallable<NodeAnalytics<DefaultTaxonomyShape>['setGroupTraits']>;
  nodeFlushPromise: NodeAnalytics<DefaultTaxonomyShape>['flush'] extends () => Promise<void>
    ? true
    : false;
  nodeShutdownPromise: NodeAnalytics<DefaultTaxonomyShape>['shutdown'] extends () => Promise<void>
    ? true
    : false;

  // Layer 2 — every query method returns Promise<QueryResult> (the whole query contract).
  funnelResult: AnalyticsQueryClient<DefaultTaxonomyShape>['funnel'] extends (
    ...args: never[]
  ) => Promise<QueryResult>
    ? true
    : false;
  retentionResult: AnalyticsQueryClient<DefaultTaxonomyShape>['retention'] extends (
    ...args: never[]
  ) => Promise<QueryResult>
    ? true
    : false;
  trendResult: AnalyticsQueryClient<DefaultTaxonomyShape>['trend'] extends (
    ...args: never[]
  ) => Promise<QueryResult>
    ? true
    : false;
  uniqueCountResult: AnalyticsQueryClient<DefaultTaxonomyShape>['uniqueCount'] extends (
    ...args: never[]
  ) => Promise<QueryResult>
    ? true
    : false;
  rawQueryResult: AnalyticsQueryClient<DefaultTaxonomyShape>['rawQuery'] extends (
    ...args: never[]
  ) => Promise<QueryResult>
    ? true
    : false;

  // Layer 2 — the flag port's load-bearing method stays async at the boundary: evaluate returns
  // Promise<FlagSet> (mirroring the query verbs' Promise<QueryResult> pin). A regression to a
  // sync FlagSet (breaking parity + bar A) flips this to false. onChange stays a callable member.
  flagOnChangeCallable: IsCallable<FeatureFlagPort<DefaultTaxonomyShape>['onChange']>;
  flagEvaluateResult: FeatureFlagPort<DefaultTaxonomyShape>['evaluate'] extends (
    ...args: never[]
  ) => Promise<FlagSet>
    ? true
    : false;
};

// Every field of `Assertions` must resolve to `true`. The const is typed as `Assertions` itself, so
// if any member resolves to `false` (a frozen member was renamed/dropped/added, or a return-category
// regressed), the literal `true` below is NOT assignable to that now-`false` field and typecheck
// FAILS — naming the exact failing member. Exported so the bindings are "used" (lint-clean) and
// importable by the runtime companion test.
export const CAPABILITY_PRESENCE: Assertions = {
  providerKeys: true,
  nodeKeys: true,
  queryKeys: true,
  flagPortKeys: true,
  trackCallable: true,
  identifyCallable: true,
  pageCallable: true,
  groupCallable: true,
  resetCallable: true,
  setTraitsCallable: true,
  registerCallable: true,
  unregisterCallable: true,
  optInCallable: true,
  optOutCallable: true,
  hasOptedOutBoolean: true,
  providerFlushPromise: true,
  providerShutdownPromise: true,
  nodeCaptureCallable: true,
  nodeSetTraitsCallable: true,
  nodeSetGroupTraitsCallable: true,
  nodeFlushPromise: true,
  nodeShutdownPromise: true,
  funnelResult: true,
  retentionResult: true,
  trendResult: true,
  uniqueCountResult: true,
  rawQueryResult: true,
  flagOnChangeCallable: true,
  flagEvaluateResult: true,
};
