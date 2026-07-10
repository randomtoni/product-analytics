import { useState, type ReactNode } from 'react';
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

describe('useFeatureFlags — StrictMode dev double-invoke', () => {
  // A port whose per-call evaluate() is externally resolvable, so the FIRST (StrictMode-orphaned)
  // evaluate can be left in-flight across the synthetic unmount and resolved AFTERWARDS.
  function makeDeferredPort() {
    const resolvers: Array<(set: FlagSet) => void> = [];
    const listeners = new Set<(set: FlagSet) => void>();
    const port = {
      evaluate: vi.fn(() => new Promise<FlagSet>((resolve) => resolvers.push(resolve))),
      onChange: vi.fn((listener: (set: FlagSet) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
    } as unknown as FeatureFlagPort;
    return {
      port,
      resolveNth(index: number, set: FlagSet) {
        resolvers[index](set);
      },
      resolverCount() {
        return resolvers.length;
      },
      fire(set: FlagSet) {
        for (const l of listeners) l(set);
      },
    };
  }

  test('an evaluate() orphaned by a StrictMode-style effect re-run resolves without clobbering committed state (the `cancelled` guard)', async () => {
    // The exact condition the hook's `cancelled` guard is written for: StrictMode's dev remount
    // (modeled here by an effect RE-RUN, which severs the first effect's closure while the hook
    // stays MOUNTED) leaves the first evaluate() in flight. When that orphaned promise resolves,
    // the severed closure's `cancelled` flag must swallow its setState — so the committed snapshot
    // NEVER flips to the orphaned value. Asserted on OBSERVABLE STATE (result.current), not on a
    // console warning: react@19 no longer emits the setState-after-unmount warning, so a warning
    // assertion would be vacuous. This one FAILS if the `cancelled` guard is removed.
    const portA = makeDeferredPort();
    const portB = makeDeferredPort();

    // Drive the hook under a provider whose client swaps between the two ports across a rerender,
    // so the effect's [flags] dependency changes while the hook (Probe) stays mounted.
    let setPort!: (p: FeatureFlagPort) => void;
    function Harness() {
      const [flags, setFlags] = useState<FeatureFlagPort>(portA.port);
      setPort = setFlags;
      return (
        <AnalyticsClientProvider client={clientWithFlags(flags)}>
          <Probe />
        </AnalyticsClientProvider>
      );
    }
    let committed: FlagSet = emptyFlagSet();
    function Probe() {
      committed = useFeatureFlags();
      return null;
    }

    await act(async () => {
      render(<Harness />);
    });

    // Swap the provider's flags slot to portB ⇒ portA's effect cleanup runs (cancelled = true for
    // portA's closure), a fresh effect runs for portB, and portA's evaluate() is now orphaned yet
    // the tree stays mounted.
    await act(async () => {
      setPort(portB.port);
    });

    // portB commits a distinctive LIVE snapshot via onChange — the value the hook must keep.
    const live = makeFlagSet({ isEnabled: (k) => k === 'live', reason: () => 'resolved' });
    act(() => portB.fire(live));
    expect(committed.isEnabled('live')).toBe(true);

    // Resolve portA's ORPHANED evaluate with a different stale set. Guard intact ⇒ no-op; guard
    // removed ⇒ the severed closure's setSet(stale) clobbers the live set on the mounted tree.
    const orphanedStale = makeFlagSet({
      isEnabled: (k) => k === 'orphaned',
      reason: () => 'bootstrap',
    });
    await act(async () => {
      portA.resolveNth(0, orphanedStale);
    });

    // Observable state: the committed snapshot is STILL portB's live set, never the orphaned one.
    expect(committed.isEnabled('live')).toBe(true);
    expect(committed.isEnabled('orphaned')).toBe(false);
    expect(committed.reason('live')).toBe('resolved');
  });

  test('a committed onChange is not clobbered by a slower orphaned evaluate() (the `changed` guard)', async () => {
    // The `changed` half of the guard pair: an onChange set that commits BEFORE evaluate() resolves
    // is the freshest value; a late-resolving evaluate (bootstrap/stale) must not overwrite it.
    const deferred = makeDeferredPort();
    const { result } = await act(async () =>
      renderHook(() => useFeatureFlags(), {
        wrapper: providerWith(clientWithFlags(deferred.port)),
      })
    );

    const network = makeFlagSet({ isEnabled: () => true, reason: () => 'resolved' });
    act(() => deferred.fire(network));
    expect(result.current.isEnabled('x')).toBe(true);

    await act(async () => {
      deferred.resolveNth(0, makeFlagSet({ isEnabled: () => false, reason: () => 'bootstrap' }));
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

  test('the absent-slot snapshot keeps a stable identity across re-renders (no per-render churn)', () => {
    // The no-port path must return the SAME FlagSet reference on every render — a fresh
    // emptyFlagSet() per render would re-fire consumer effects keyed on it and break React.memo
    // children downstream. Force a re-render and assert reference identity is preserved.
    const { result, rerender } = renderHook(() => useFeatureFlags(), {
      wrapper: providerWith(clientWithFlags(undefined)),
    });
    const first = result.current;
    rerender();
    const second = result.current;
    expect(second).toBe(first);
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
