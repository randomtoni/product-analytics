import type { ReactNode } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest';
import { emptyFlagSet } from 'analytics-kit';
import type { FeatureFlagPort, FlagSet, RootAnalytics, ShapeOf } from 'analytics-kit';
import { AnalyticsClientProvider } from './analytics-client-provider';
import { useFeatureFlags } from './use-feature-flags';
import { createRecordingClient } from './recording-client.test-helper';

// A controllable in-memory FlagSet — the reads a hook exercises off a resolved snapshot.
function makeFlagSet(overrides: Partial<FlagSet> = {}): FlagSet {
  return {
    isEnabled: () => false,
    getFlag: () => undefined,
    getPayload: () => undefined,
    getAll: () => ({}),
    degraded: false,
    reason: () => 'resolved',
    ...overrides,
  } as FlagSet;
}

// A mock FeatureFlagPort whose onChange fires and evaluate() resolution are driven by the test,
// mirroring the browser adapter's contract: onChange fires on each committed set; evaluate()
// serves the current snapshot (bootstrap/cache) asynchronously.
function makeFlagPort(initial: FlagSet) {
  const listeners = new Set<(set: FlagSet) => void>();
  const port = {
    evaluate: vi.fn(async () => initial),
    onChange: vi.fn((listener: (set: FlagSet) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  } satisfies FeatureFlagPort;
  return {
    port: port as unknown as FeatureFlagPort,
    fire(set: FlagSet) {
      for (const listener of listeners) {
        listener(set);
      }
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

function clientWithFlags(flags: FeatureFlagPort | undefined): RootAnalytics {
  const client = createRecordingClient() as RootAnalytics;
  return { ...client, flags } as RootAnalytics;
}

function providerWith(client: RootAnalytics) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AnalyticsClientProvider client={client}>{children}</AnalyticsClientProvider>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useFeatureFlags — subscription + re-render', () => {
  test('seeds the snapshot from evaluate() on mount, then re-renders when onChange fires', async () => {
    const bootstrap = makeFlagSet({ reason: () => 'bootstrap' });
    const resolved = makeFlagSet({ isEnabled: (k) => k === 'beta', reason: () => 'resolved' });
    const mock = makeFlagPort(bootstrap);

    const { result } = await act(async () =>
      renderHook(() => useFeatureFlags(), { wrapper: providerWith(clientWithFlags(mock.port)) })
    );

    // evaluate() resolved during the mount act(): the initial snapshot is the bootstrap set.
    expect(result.current.reason('any')).toBe('bootstrap');
    expect(mock.port.evaluate).toHaveBeenCalledTimes(1);
    expect(mock.port.onChange).toHaveBeenCalledTimes(1);

    // A committed onChange set re-renders the hook with the network-resolved snapshot.
    act(() => mock.fire(resolved));
    expect(result.current.isEnabled('beta')).toBe(true);
    expect(result.current.reason('beta')).toBe('resolved');
  });

  test('unsubscribes on unmount (the onChange cleanup runs)', async () => {
    const mock = makeFlagPort(makeFlagSet());
    const { unmount } = await act(async () =>
      renderHook(() => useFeatureFlags(), { wrapper: providerWith(clientWithFlags(mock.port)) })
    );
    expect(mock.listenerCount()).toBe(1);
    unmount();
    expect(mock.listenerCount()).toBe(0);
  });

  test('an onChange fire after unmount does not update or throw (cleanup severed the listener)', async () => {
    const mock = makeFlagPort(makeFlagSet());
    const { unmount } = await act(async () =>
      renderHook(() => useFeatureFlags(), { wrapper: providerWith(clientWithFlags(mock.port)) })
    );
    unmount();
    // The listener was removed by cleanup, so a stray fire is a no-op — never a setState-after-unmount.
    expect(() => mock.fire(makeFlagSet({ isEnabled: () => true }))).not.toThrow();
  });

  test('a committed onChange wins the race — a slower evaluate() does not clobber it', async () => {
    let resolveEvaluate!: (set: FlagSet) => void;
    const bootstrap = makeFlagSet({ reason: () => 'bootstrap' });
    const network = makeFlagSet({ isEnabled: () => true, reason: () => 'resolved' });
    const listeners = new Set<(set: FlagSet) => void>();
    const port = {
      evaluate: vi.fn(() => new Promise<FlagSet>((r) => (resolveEvaluate = r))),
      onChange: vi.fn((listener: (set: FlagSet) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    } as unknown as FeatureFlagPort;

    const { result } = renderHook(() => useFeatureFlags(), {
      wrapper: providerWith(clientWithFlags(port)),
    });

    // onChange commits the network set BEFORE evaluate() resolves.
    act(() => {
      for (const l of listeners) l(network);
    });
    expect(result.current.isEnabled('x')).toBe(true);

    // A late evaluate() resolving to the stale bootstrap must NOT overwrite the committed set.
    await act(async () => {
      resolveEvaluate(bootstrap);
    });
    expect(result.current.isEnabled('x')).toBe(true);
    expect(result.current.reason('x')).toBe('resolved');
  });
});

describe('useFeatureFlags — outside a provider', () => {
  test('throws the in-provider sentinel error, naming the provider', () => {
    expect(() => renderHook(() => useFeatureFlags())).toThrow(/AnalyticsClientProvider/);
  });

  test('the thrown error is a plain Error with an explanatory message', () => {
    let caught: unknown;
    try {
      renderHook(() => useFeatureFlags());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('AnalyticsClientProvider');
  });
});

describe('useFeatureFlags — absent flags slot (bar B: config-only adoption)', () => {
  test('returns a stable honest empty/degraded snapshot and does NOT throw when client.flags is undefined', () => {
    const { result } = renderHook(() => useFeatureFlags(), {
      wrapper: providerWith(clientWithFlags(undefined)),
    });
    expect(result.current.isEnabled('anything')).toBe(false);
    expect(result.current.getFlag('anything')).toBeUndefined();
    expect(result.current.getPayload('anything')).toBeUndefined();
    expect(result.current.getAll()).toEqual({});
    expect(result.current.degraded).toBe(true);
    expect(result.current.reason('anything')).toBe('unresolved');
  });

  test('the absent-slot snapshot matches the seam-canonical emptyFlagSet() (no React-local fork)', () => {
    const { result } = renderHook(() => useFeatureFlags(), {
      wrapper: providerWith(clientWithFlags(undefined)),
    });
    const canonical = emptyFlagSet();
    expect(result.current.isEnabled('k')).toBe(canonical.isEnabled('k'));
    expect(result.current.degraded).toBe(canonical.degraded);
    expect(result.current.reason('k')).toBe(canonical.reason('k'));
    expect(result.current.getAll()).toEqual(canonical.getAll());
  });

  test('a component reading the absent-slot snapshot renders without crashing', () => {
    function Consumer() {
      const flags = useFeatureFlags();
      return <span>{flags.isEnabled('x') ? 'on' : 'off'}</span>;
    }
    const { container } = render(
      <AnalyticsClientProvider client={clientWithFlags(undefined)}>
        <Consumer />
      </AnalyticsClientProvider>
    );
    expect(container.textContent).toBe('off');
  });

  test('with no flags slot the port is never subscribed to', async () => {
    const mock = makeFlagPort(makeFlagSet());
    await act(async () =>
      renderHook(() => useFeatureFlags(), { wrapper: providerWith(clientWithFlags(undefined)) })
    );
    expect(mock.port.evaluate).not.toHaveBeenCalled();
  });
});

describe('useFeatureFlags — taxonomy typing', () => {
  type Decl = {
    events: { e: Record<string, never> };
    flags: {
      checkout_variant: { variants: ['a', 'b']; payload: { discount: 'number' } };
      basic_gate: Record<string, never>;
    };
  };
  type AppShape = ShapeOf<Decl>;

  test('the hook return type is FlagSet<TX>, narrowing reads through TX (type-test)', () => {
    expectTypeOf(useFeatureFlags<AppShape>).returns.toEqualTypeOf<FlagSet<AppShape>>();
  });

  // Type-level only: never invoked (would throw the no-provider error at runtime). It exists so
  // tsc checks that the hook's reads narrow identically to the port's own narrowing off TX['flags'].
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function _taxonomyFlowsTypeCheck() {
    const flags = useFeatureFlags<AppShape>();

    const variant = flags.getFlag('checkout_variant');
    expectTypeOf(variant).toEqualTypeOf<'a' | 'b' | boolean | undefined>();

    const payload = flags.getPayload('checkout_variant');
    expectTypeOf(payload).toEqualTypeOf<{ discount: number } | undefined>();

    // A variant-less flag narrows getFlag to boolean.
    const gate = flags.getFlag('basic_gate');
    expectTypeOf(gate).toEqualTypeOf<boolean | undefined>();
  }
});
