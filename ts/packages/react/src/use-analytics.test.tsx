import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { createAnalytics } from '@randomtoni/analytics-kit-browser';
import { defineTaxonomy } from '@randomtoni/analytics-kit';
import type {
  AnalyticsProvider,
  RootAnalytics,
  ShapeOf,
  TaxonomyShape,
} from '@randomtoni/analytics-kit';
import { AnalyticsClientProvider } from './analytics-client-provider';
import { useAnalytics } from './use-analytics';
import { createRecordingClient } from './recording-client.test-helper';

const appTaxonomy = defineTaxonomy({
  events: {
    signed_up: { plan: 'string', seats: 'number' },
  },
  traits: { plan: 'string' },
});

type AppEventsShape = ShapeOf<typeof appTaxonomy.decl>;

function providerWith(client: RootAnalytics) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AnalyticsClientProvider client={client}>{children}</AnalyticsClientProvider>;
  };
}

describe('useAnalytics — instance identity', () => {
  test('returns the exact client the provider provided (same instance)', () => {
    const client = createRecordingClient();
    const { result } = renderHook(() => useAnalytics(), { wrapper: providerWith(client) });
    expect(result.current).toBe(client);
  });

  test('inside a config-branch provider it returns a real RootAnalytics from render 1', () => {
    function Wrapper({ children }: { children: ReactNode }) {
      return <AnalyticsClientProvider config={{ key: 'test-key' }}>{children}</AnalyticsClientProvider>;
    }
    const { result } = renderHook(() => useAnalytics(), { wrapper: Wrapper });
    expect(typeof result.current.track).toBe('function');
    expect(typeof result.current.page).toBe('function');
    expect(typeof result.current.context).toBe('function');
  });
});

describe('useAnalytics — outside a provider', () => {
  test('throws a clear error naming the provider by name', () => {
    expect(() => renderHook(() => useAnalytics())).toThrow(/AnalyticsClientProvider/);
  });

  test('the thrown error is a plain Error with an explanatory message', () => {
    let caught: unknown;
    try {
      renderHook(() => useAnalytics());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('AnalyticsClientProvider');
  });
});

describe('useAnalytics — bar A (neutral facade, adapter-swap free)', () => {
  test('returns the neutral facade, not a vendor client — verbs are the neutral 15 + context()', () => {
    const client = createRecordingClient();
    const { result } = renderHook(() => useAnalytics(), { wrapper: providerWith(client) });

    const returned = result.current;
    expect(typeof returned.track).toBe('function');
    expect(typeof returned.identify).toBe('function');
    expect(typeof returned.page).toBe('function');
    expect(typeof returned.group).toBe('function');
    expect(typeof returned.reset).toBe('function');
    expect(typeof returned.setTraits).toBe('function');
    expect(typeof returned.register).toBe('function');
    expect(typeof returned.unregister).toBe('function');
    expect(typeof returned.optIn).toBe('function');
    expect(typeof returned.optOut).toBe('function');
    expect(typeof returned.hasOptedOut).toBe('function');
    expect(typeof returned.flush).toBe('function');
    expect(typeof returned.shutdown).toBe('function');
    expect(typeof returned.context).toBe('function');
  });
});

describe('useAnalytics — bar B (unkeyed no-op rides through)', () => {
  test('under an unkeyed provider the returned client is silent and never throws', () => {
    const unkeyed = createAnalytics({});
    const { result } = renderHook(() => useAnalytics(), { wrapper: providerWith(unkeyed) });

    expect(() => result.current.track('anything' as never)).not.toThrow();
    expect(() => result.current.page()).not.toThrow();
  });
});

describe('useAnalytics — frozen-15 (adds no verb)', () => {
  test('keyof the returned client matches the neutral facade + context(), no extra verb', () => {
    const client = createRecordingClient();
    const { result } = renderHook(() => useAnalytics(), { wrapper: providerWith(client) });

    const keys = new Set(Object.keys(result.current));
    const expected = new Set([
      'track',
      'identify',
      'page',
      'group',
      'reset',
      'setTraits',
      'register',
      'unregister',
      'optIn',
      'optOut',
      'hasOptedOut',
      'flush',
      'shutdown',
      'context',
    ]);
    expect(keys).toEqual(expected);
  });
});

test('the returned client keyset matches keyof RootAnalytics — the hook wraps nothing (type-level)', () => {
  expectTypeOf<keyof ReturnType<typeof useAnalytics>>().toEqualTypeOf<keyof RootAnalytics>();
});

test('return type is the clean, non-nullable widened RootAnalytics — context() survives, not undefined', () => {
  expectTypeOf<ReturnType<typeof useAnalytics>>().toEqualTypeOf<RootAnalytics>();
  expectTypeOf<ReturnType<typeof useAnalytics>>().not.toEqualTypeOf<AnalyticsProvider>();
  expectTypeOf<ReturnType<typeof useAnalytics>>().not.toEqualTypeOf<RootAnalytics | undefined>();

  expectTypeOf<ReturnType<typeof useAnalytics>['context']>().toBeFunction();
  expectTypeOf<ReturnType<ReturnType<typeof useAnalytics>['context']>>().toMatchTypeOf<{
    track: unknown;
  }>();
});

test('the hook generic is a TaxonomyShape, and taxonomy flows through the return type', () => {
  expect(appTaxonomy.decl.events.signed_up).toEqual({ plan: 'string', seats: 'number' });

  expectTypeOf(useAnalytics<AppEventsShape>).returns.toEqualTypeOf<RootAnalytics<AppEventsShape>>();

  type IsShape = AppEventsShape extends TaxonomyShape ? true : false;
  expectTypeOf<IsShape>().toEqualTypeOf<true>();
});

// Type-level only: this function is NEVER called — it exists so `tsc` checks the call
// sites. Invoking `useAnalytics()` here would throw the no-provider error at runtime.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _taxonomyFlowsTypeCheck() {
  const analytics = useAnalytics<AppEventsShape>();

  analytics.track('signed_up', { plan: 'pro', seats: 5 });

  // @ts-expect-error — 'checkout_started' is not a declared event in AppEventsShape
  analytics.track('checkout_started', {});

  // @ts-expect-error — 'seats' must be a number per the declared taxonomy
  analytics.track('signed_up', { plan: 'pro', seats: 'many' });
}
