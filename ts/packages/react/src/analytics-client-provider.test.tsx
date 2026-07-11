import { StrictMode, useContext, useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AnalyticsConfig, RootAnalytics } from '@randomtoni/analytics-kit-browser';
import * as browser from '@randomtoni/analytics-kit-browser';
import { AnalyticsClientProvider } from './analytics-client-provider';
import {
  AnalyticsClientContext,
  NOT_IN_PROVIDER,
  type AnalyticsClientContextValue,
} from './analytics-client-context';
import { createRecordingClient } from './recording-client.test-helper';

function ClientProbe({ onClient }: { onClient: (value: AnalyticsClientContextValue) => void }) {
  const value = useContext(AnalyticsClientContext);
  onClient(value);
  return <span>probe</span>;
}

const keyedConfig: AnalyticsConfig = { key: 'test-key' };
const unkeyedConfig: AnalyticsConfig = {};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AnalyticsClientProvider — config branch', () => {
  test('renders children and provides a constructed RootAnalytics from render 1', () => {
    let seen: AnalyticsClientContextValue | undefined;
    render(
      <AnalyticsClientProvider config={keyedConfig}>
        <ClientProbe onClient={(v) => (seen = v)} />
      </AnalyticsClientProvider>
    );

    expect(screen.getByText('probe')).toBeDefined();
    expect(seen).not.toBe(NOT_IN_PROVIDER);
    expect(seen).toBeDefined();
    const client = seen as RootAnalytics;
    expect(typeof client.track).toBe('function');
    expect(typeof client.context).toBe('function');
  });

  test('SSR-safe: renderToString (no DOM) constructs the client and a child sees a real client', () => {
    let seen: AnalyticsClientContextValue | undefined;
    const html = renderToString(
      <AnalyticsClientProvider config={keyedConfig}>
        <ClientProbe onClient={(v) => (seen = v)} />
      </AnalyticsClientProvider>
    );

    expect(html).toContain('probe');
    expect(seen).not.toBe(NOT_IN_PROVIDER);
    expect(seen).toBeDefined();
    expect(typeof (seen as RootAnalytics).track).toBe('function');
  });

  test('calls the public createAnalytics (bar A) — never an adapter internal', () => {
    const spy = vi.spyOn(browser, 'createAnalytics');
    render(
      <AnalyticsClientProvider config={keyedConfig}>
        <span>child</span>
      </AnalyticsClientProvider>
    );
    expect(spy).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(keyedConfig);
  });

  test('create-once across re-renders: one construction and one stable client (no StrictMode)', () => {
    const spy = vi.spyOn(browser, 'createAnalytics');
    const seen: AnalyticsClientContextValue[] = [];
    let bump!: () => void;

    function Rerenderer() {
      const [, setN] = useState(0);
      bump = () => setN((n) => n + 1);
      return (
        <AnalyticsClientProvider config={keyedConfig}>
          <ClientProbe onClient={(v) => seen.push(v)} />
        </AnalyticsClientProvider>
      );
    }

    render(<Rerenderer />);
    act(() => bump());
    act(() => bump());

    expect(spy).toHaveBeenCalledTimes(1);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    const first = seen[0];
    for (const value of seen) {
      expect(value).toBe(first);
    }
  });

  test('shuts down the owned client on unmount', () => {
    vi.useFakeTimers();
    try {
      const recording = createRecordingClient();
      const spy = vi.spyOn(browser, 'createAnalytics').mockReturnValue(recording);
      const { unmount } = render(
        <AnalyticsClientProvider config={keyedConfig}>
          <span>child</span>
        </AnalyticsClientProvider>
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(recording.shutdown).not.toHaveBeenCalled();
      act(() => {
        unmount();
      });
      act(() => {
        vi.runAllTimers();
      });
      expect(recording.shutdown).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('unkeyed config still renders and provides a no-op-backed client (bar B)', () => {
    let seen: AnalyticsClientContextValue | undefined;
    render(
      <AnalyticsClientProvider config={unkeyedConfig}>
        <ClientProbe onClient={(v) => (seen = v)} />
      </AnalyticsClientProvider>
    );
    expect(seen).not.toBe(NOT_IN_PROVIDER);
    const client = seen as RootAnalytics;
    expect(() => client.track('anything' as never)).not.toThrow();
    expect(() => client.page()).not.toThrow();
  });
});

describe('AnalyticsClientProvider — StrictMode', () => {
  // React's dev-mode StrictMode intentionally double-invokes pure lazy `useState`
  // initializers to surface impurity, so raw `createAnalytics` call count is NOT the
  // probe (construction is DOM-free/side-effect-free — the discarded build leaks
  // nothing). The invariant is: the committed mount provides exactly ONE stable client
  // and shuts down exactly that one on unmount.
  test('the committed mount provides exactly one stable client and does not double-provide', () => {
    const seen: AnalyticsClientContextValue[] = [];
    render(
      <StrictMode>
        <AnalyticsClientProvider config={keyedConfig}>
          <ClientProbe onClient={(v) => seen.push(v)} />
        </AnalyticsClientProvider>
      </StrictMode>
    );
    const committed = seen[seen.length - 1];
    expect(committed).not.toBe(NOT_IN_PROVIDER);
    expect(committed).toBeDefined();
    for (const value of seen) {
      expect(value).toBe(committed);
    }
  });

  // StrictMode's dev unmount→remount is synchronous within a tick: the owned client's
  // cleanup only SCHEDULES a deferred shutdown, and the immediately-following remount's
  // effect cancels it before the 0-delay timer can fire. The committed client therefore
  // survives the dev cycle with its listeners intact — it is NOT shut down. Regression
  // guard for defect #12 (StrictMode detaching the live client's DOM listeners).
  test('the config-branch owned client survives the StrictMode dev cycle without being shut down', () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(browser, 'createAnalytics').mockImplementation(() => createRecordingClient());
      const seen: AnalyticsClientContextValue[] = [];
      render(
        <StrictMode>
          <AnalyticsClientProvider config={keyedConfig}>
            <ClientProbe onClient={(v) => seen.push(v)} />
          </AnalyticsClientProvider>
        </StrictMode>
      );
      const committed = seen[seen.length - 1] as ReturnType<typeof createRecordingClient>;

      // The deferred shutdown scheduled by the dev unmount was cancelled synchronously by
      // the remount, so flushing every pending timer fires no shutdown.
      act(() => {
        vi.runAllTimers();
      });
      expect(committed.shutdown).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // A real unmount (no remount) has nothing to cancel the deferred shutdown, so once the
  // 0-delay timer runs the owned client IS drained. Keeps the E9 ownership contract:
  // config-branch owns → shuts down on real unmount.
  test('the config-branch owned client is shut down on a real unmount under StrictMode', () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(browser, 'createAnalytics').mockImplementation(() => createRecordingClient());
      const seen: AnalyticsClientContextValue[] = [];
      const { unmount } = render(
        <StrictMode>
          <AnalyticsClientProvider config={keyedConfig}>
            <ClientProbe onClient={(v) => seen.push(v)} />
          </AnalyticsClientProvider>
        </StrictMode>
      );
      const committed = seen[seen.length - 1] as ReturnType<typeof createRecordingClient>;

      act(() => {
        unmount();
      });
      expect(committed.shutdown).not.toHaveBeenCalled();

      act(() => {
        vi.runAllTimers();
      });
      expect(committed.shutdown).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a caller-owned client is never shut down under StrictMode', () => {
    const recording = createRecordingClient();
    const { unmount } = render(
      <StrictMode>
        <AnalyticsClientProvider client={recording}>
          <span>child</span>
        </AnalyticsClientProvider>
      </StrictMode>
    );
    unmount();
    expect(recording.shutdown).not.toHaveBeenCalled();
  });
});

describe('AnalyticsClientProvider — client branch', () => {
  test('provides the caller client without constructing a new one', () => {
    const recording = createRecordingClient();
    const spy = vi.spyOn(browser, 'createAnalytics');
    let seen: AnalyticsClientContextValue | undefined;
    render(
      <AnalyticsClientProvider client={recording}>
        <ClientProbe onClient={(v) => (seen = v)} />
      </AnalyticsClientProvider>
    );
    expect(spy).not.toHaveBeenCalled();
    expect(seen).toBe(recording);
  });

  test('does NOT shut down a caller-owned client on unmount', () => {
    const recording = createRecordingClient();
    const { unmount } = render(
      <AnalyticsClientProvider client={recording}>
        <span>child</span>
      </AnalyticsClientProvider>
    );
    unmount();
    expect(recording.shutdown).not.toHaveBeenCalled();
  });
});

describe('AnalyticsClientProvider — no auto-pageview', () => {
  test('mounting the provider fires no page() and installs no history listener', () => {
    const recording = createRecordingClient();
    vi.spyOn(browser, 'createAnalytics').mockReturnValue(recording);
    const addSpy = vi.spyOn(window, 'addEventListener');
    render(
      <AnalyticsClientProvider config={keyedConfig}>
        <span>child</span>
      </AnalyticsClientProvider>
    );
    expect(recording.page).not.toHaveBeenCalled();
    expect(recording.track).not.toHaveBeenCalled();
    const historyListeners = addSpy.mock.calls.filter(
      ([type]) => type === 'popstate' || type === 'pushstate' || type === 'hashchange'
    );
    expect(historyListeners).toHaveLength(0);
  });

  test('client branch fires no page() on mount', () => {
    const recording = createRecordingClient();
    render(
      <AnalyticsClientProvider client={recording}>
        <span>child</span>
      </AnalyticsClientProvider>
    );
    expect(recording.page).not.toHaveBeenCalled();
  });
});

describe('AnalyticsClientProvider — both props passed', () => {
  beforeEach(() => {
    vi.spyOn(browser, 'createAnalytics');
  });

  test('client wins and emits exactly one dev-mode warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recording = createRecordingClient();
    let seen: AnalyticsClientContextValue | undefined;
    render(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <AnalyticsClientProvider {...({ client: recording, config: keyedConfig } as any)}>
        <ClientProbe onClient={(v) => (seen = v)} />
      </AnalyticsClientProvider>
    );
    expect(seen).toBe(recording);
    expect(browser.createAnalytics).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('warning is suppressed when NODE_ENV === production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recording = createRecordingClient();
    try {
      render(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <AnalyticsClientProvider {...({ client: recording, config: keyedConfig } as any)}>
          <span>child</span>
        </AnalyticsClientProvider>
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe('AnalyticsClientContext — sentinel default', () => {
  test('reading the raw context outside any provider yields the sentinel, not undefined', () => {
    let seen: AnalyticsClientContextValue | undefined;
    render(<ClientProbe onClient={(v) => (seen = v)} />);
    expect(seen).toBe(NOT_IN_PROVIDER);
    expect(seen).not.toBeUndefined();
  });

  test('inside a provider the context holds a real client, never the sentinel', () => {
    const recording = createRecordingClient();
    let seen: AnalyticsClientContextValue | undefined;
    render(
      <AnalyticsClientProvider client={recording}>
        <ClientProbe onClient={(v) => (seen = v)} />
      </AnalyticsClientProvider>
    );
    expect(seen).not.toBe(NOT_IN_PROVIDER);
    expect(seen).not.toBeUndefined();
    expect(seen).toBe(recording);
  });
});
