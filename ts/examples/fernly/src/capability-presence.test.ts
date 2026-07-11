import { describe, expect, it } from 'vitest';
import * as analyticsKit from '@randomtoni/analytics-kit';
import * as node from '@randomtoni/analytics-kit-node';
import { CAPABILITY_PRESENCE } from './capability-presence';

// E11-S4 capability-presence — RUNTIME half.
//
// The type-only interface surfaces (`AnalyticsProvider` / `NodeAnalytics` / `AnalyticsQueryClient`)
// are asserted at TYPECHECK time in `./capability-presence.ts` (they have no runtime object — an
// `Object.keys` inspection cannot see them). THIS test asserts the actual VALUE exports exist on
// the built `dist` runtime — proving tsup emitted the runtime entry, the companion half of the
// staleness tripwire. It also pulls the typecheck-time module into the test graph (the import
// forces `capability-presence.ts` to compile) so a red `typecheck` and a red `test` both surface.

describe('capability-presence — runtime value exports (proves tsup emitted the dist runtime entry)', () => {
  it('the seam package exposes its runtime value exports on dist', () => {
    // createAnalytics (config-selected factory), NoopAdapter (null adapter), defineTaxonomy
    // (typed-taxonomy mechanism) — the BRIEF §Adapters + §Agnostic-design-rules value surface.
    expect(typeof analyticsKit.createAnalytics).toBe('function');
    expect(typeof analyticsKit.NoopAdapter).toBe('function');
    expect(typeof analyticsKit.defineTaxonomy).toBe('function');
    // emptyFlagSet — the FlagSet null-object factory (E12-S1), a value export re-exported
    // from the seam alongside NoopAdapter, so it joins the runtime presence list by the same
    // rationale (a working, structurally-complete "nothing-resolved" snapshot must ship on dist).
    expect(typeof analyticsKit.emptyFlagSet).toBe('function');
  });

  it('the node package exposes its runtime value exports on dist', () => {
    // createAnalytics (node factory) + createQueryClient (query factory) — the neutral node value
    // surface. The concrete query adapters (HTTP + warehouse) are INTERNAL, reached only through
    // createQueryClient's config-selection (bar A: a consumer never couples to a named backend).
    expect(typeof node.createAnalytics).toBe('function');
    expect(typeof node.createQueryClient).toBe('function');
    // createFlagClient — the standalone node flag-client factory (E12-S3). A standalone factory,
    // NOT a NodeAnalytics member (node has no flags slot), so its presence is asserted here as a
    // value export — the flag capability reachable on the built node dist. The concrete remote
    // adapter (+ the no-op) are INTERNAL, reached only through createFlagClient's config-selection.
    expect(typeof node.createFlagClient).toBe('function');
  });

  it('the typecheck-time presence assertion is wired into the graph and all-true', () => {
    // Every field of CAPABILITY_PRESENCE is `true` by construction — if any frozen member had been
    // renamed/dropped/added or a return-category regressed, `capability-presence.ts` would already
    // have FAILED typecheck (the primary gate). Asserting it here keeps the file reachable from the
    // test graph too, so the tripwire is visible in both `typecheck` and `test`.
    expect(Object.values(CAPABILITY_PRESENCE).every((v) => v === true)).toBe(true);
  });
});
