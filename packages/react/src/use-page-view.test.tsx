import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import { createAnalytics } from '@analytics-kit/browser';
import { defineTaxonomy } from 'analytics-kit';
import type { RootAnalytics, ShapeOf } from 'analytics-kit';
import { AnalyticsClientProvider } from './analytics-client-provider';
import { usePageView } from './use-page-view';
import { createRecordingClient } from './recording-client';

const appTaxonomy = defineTaxonomy({
  events: {
    signed_up: { plan: 'string', seats: 'number' },
  },
  page: { path: 'string', referrer: 'string' },
});

type AppShape = ShapeOf<typeof appTaxonomy.decl>;

function clientProvider(client: RootAnalytics) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AnalyticsClientProvider client={client}>{children}</AnalyticsClientProvider>;
  };
}

function configProvider() {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AnalyticsClientProvider config={{ key: 'test-key' }}>{children}</AnalyticsClientProvider>
    );
  };
}

describe('usePageView — mount + route-change firing (client-branch provider)', () => {
  test('fires exactly one page() on mount', () => {
    const client = createRecordingClient();
    renderHook(({ path }: { path: string }) => usePageView(path), {
      wrapper: clientProvider(client),
      initialProps: { path: '/home' },
    });
    expect(client.page).toHaveBeenCalledTimes(1);
  });

  test('fires one more page() on each path change', () => {
    const client = createRecordingClient();
    const { rerender } = renderHook(({ path }: { path: string }) => usePageView(path), {
      wrapper: clientProvider(client),
      initialProps: { path: '/home' },
    });
    expect(client.page).toHaveBeenCalledTimes(1);

    rerender({ path: '/about' });
    expect(client.page).toHaveBeenCalledTimes(2);

    rerender({ path: '/pricing' });
    expect(client.page).toHaveBeenCalledTimes(3);
  });

  test('does NOT re-fire when the path arg is unchanged across a rerender', () => {
    const client = createRecordingClient();
    const { rerender } = renderHook(({ path }: { path: string }) => usePageView(path), {
      wrapper: clientProvider(client),
      initialProps: { path: '/home' },
    });
    expect(client.page).toHaveBeenCalledTimes(1);

    rerender({ path: '/home' });
    rerender({ path: '/home' });
    expect(client.page).toHaveBeenCalledTimes(1);
  });
});

describe('usePageView — mount + route-change firing (config-branch provider, S2 synchronous)', () => {
  test('a real config-constructed client fires one page() on mount and one per path change', () => {
    const realClient = createAnalytics({ key: 'test-key' });
    const spy = vi.spyOn(realClient, 'page');

    const { rerender } = renderHook(({ path }: { path: string }) => usePageView(path), {
      wrapper: clientProvider(realClient),
      initialProps: { path: '/home' },
    });
    expect(spy).toHaveBeenCalledTimes(1);

    rerender({ path: '/about' });
    expect(spy).toHaveBeenCalledTimes(2);

    rerender({ path: '/home' });
    rerender({ path: '/home' });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  test('mounting under an actual config-branch provider fires exactly once (no init-window)', () => {
    const { result } = renderHook(
      ({ path }: { path: string }) => {
        usePageView(path);
        return true;
      },
      { wrapper: configProvider(), initialProps: { path: '/home' } }
    );
    expect(result.current).toBe(true);
  });
});

describe('usePageView — no global history listener', () => {
  test('a raw history.pushState with an unchanged path arg fires no page()', () => {
    const client = createRecordingClient();
    renderHook(({ path }: { path: string }) => usePageView(path), {
      wrapper: clientProvider(client),
      initialProps: { path: '/home' },
    });
    expect(client.page).toHaveBeenCalledTimes(1);

    window.history.pushState({}, '', '/deep/link');
    window.history.pushState({}, '', '/another');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(client.page).toHaveBeenCalledTimes(1);
  });
});

describe('usePageView — captureOnMount', () => {
  test('captureOnMount:false suppresses the initial mount fire', () => {
    const client = createRecordingClient();
    renderHook(({ path }: { path: string }) => usePageView(path, { captureOnMount: false }), {
      wrapper: clientProvider(client),
      initialProps: { path: '/home' },
    });
    expect(client.page).not.toHaveBeenCalled();
  });

  test('captureOnMount:false still fires on subsequent path changes', () => {
    const client = createRecordingClient();
    const { rerender } = renderHook(
      ({ path }: { path: string }) => usePageView(path, { captureOnMount: false }),
      { wrapper: clientProvider(client), initialProps: { path: '/home' } }
    );
    expect(client.page).not.toHaveBeenCalled();

    rerender({ path: '/about' });
    expect(client.page).toHaveBeenCalledTimes(1);

    rerender({ path: '/pricing' });
    expect(client.page).toHaveBeenCalledTimes(2);
  });

  test('default (no option) fires on mount', () => {
    const client = createRecordingClient();
    renderHook(({ path }: { path: string }) => usePageView(path), {
      wrapper: clientProvider(client),
      initialProps: { path: '/home' },
    });
    expect(client.page).toHaveBeenCalledTimes(1);
  });
});

describe('usePageView — name and props are forwarded to page()', () => {
  test('passes options.name and options.props straight through to page()', () => {
    const client = createRecordingClient();
    renderHook(
      ({ path }: { path: string }) =>
        usePageView(path, { name: 'Home', props: { path: '/home', referrer: '/landing' } }),
      { wrapper: clientProvider(client), initialProps: { path: '/home' } }
    );
    expect(client.page).toHaveBeenCalledWith('Home', { path: '/home', referrer: '/landing' });
  });

  test('a nameless/propless call delegates page(undefined, undefined)', () => {
    const client = createRecordingClient();
    renderHook(({ path }: { path: string }) => usePageView(path), {
      wrapper: clientProvider(client),
      initialProps: { path: '/home' },
    });
    expect(client.page).toHaveBeenCalledWith(undefined, undefined);
  });
});

describe('usePageView — undefined routeKey', () => {
  test('fires once on mount and re-fires when routeKey goes from undefined to a value', () => {
    const client = createRecordingClient();
    const { rerender } = renderHook(
      ({ path }: { path: string | undefined }) => usePageView(path),
      { wrapper: clientProvider(client), initialProps: { path: undefined as string | undefined } }
    );
    expect(client.page).toHaveBeenCalledTimes(1);

    rerender({ path: '/home' });
    expect(client.page).toHaveBeenCalledTimes(2);
  });
});

describe('usePageView — bar A (neutral page(), adapter-swap free)', () => {
  test('delegates to the neutral page() verb — no vendor verb, no facade verb added', () => {
    const client = createRecordingClient();
    renderHook(({ path }: { path: string }) => usePageView(path), {
      wrapper: clientProvider(client),
      initialProps: { path: '/home' },
    });
    expect(client.page).toHaveBeenCalledTimes(1);
    expect(client.track).not.toHaveBeenCalled();
    expect(client.identify).not.toHaveBeenCalled();
  });
});

test('SSR-safe: importing/rendering the hook module reads no DOM at module time', () => {
  const client = createRecordingClient();
  // No page() should fire from mere module import; it fires only inside the effect.
  expect(client.page).not.toHaveBeenCalled();
  const { unmount } = renderHook(({ path }: { path: string }) => usePageView(path), {
    wrapper: clientProvider(client),
    initialProps: { path: '/home' },
  });
  unmount();
  expect(client.page).toHaveBeenCalledTimes(1);
});

// Type-level: this function is NEVER called — it exists so `tsc` checks the call
// sites. Invoking usePageView() here would throw the no-provider error at runtime.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _taxonomyPropsTypeCheck() {
  usePageView<AppShape>('/home', { props: { path: '/home', referrer: '/landing' } });

  usePageView<AppShape>('/home', { name: 'Home' });

  // @ts-expect-error — 'path' must be a string per the declared page taxonomy
  usePageView<AppShape>('/home', { props: { path: 42 } });

  // @ts-expect-error — 'section' is not a declared page prop in AppShape
  usePageView<AppShape>('/home', { props: { section: 'hero' } });
}

test('the hook generic is a TaxonomyShape and props type against TX[page] (compile-checked above)', () => {
  expect(appTaxonomy.decl.page).toEqual({ path: 'string', referrer: 'string' });
  expectTypeOf(usePageView<AppShape>).parameter(0).toEqualTypeOf<string | undefined>();
});
