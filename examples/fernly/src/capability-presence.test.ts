import { describe, expect, it } from 'vitest';
import * as analyticsKit from 'analytics-kit';
import * as node from '@analytics-kit/node';
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
  });

  it('the node package exposes its runtime value exports on dist', () => {
    // createAnalytics (node factory) + createQueryClient (query factory) — the neutral node value
    // surface. The concrete query adapters (HTTP + warehouse) are INTERNAL, reached only through
    // createQueryClient's config-selection (bar A: a consumer never couples to a named backend).
    expect(typeof node.createAnalytics).toBe('function');
    expect(typeof node.createQueryClient).toBe('function');
  });

  it('the typecheck-time presence assertion is wired into the graph and all-true', () => {
    // Every field of CAPABILITY_PRESENCE is `true` by construction — if any frozen member had been
    // renamed/dropped/added or a return-category regressed, `capability-presence.ts` would already
    // have FAILED typecheck (the primary gate). Asserting it here keeps the file reachable from the
    // test graph too, so the tripwire is visible in both `typecheck` and `test`.
    expect(Object.values(CAPABILITY_PRESENCE).every((v) => v === true)).toBe(true);
  });
});
