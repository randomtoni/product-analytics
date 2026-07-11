import type { RootAnalytics, ScopedAnalytics } from '@randomtoni/analytics-kit';
import { vi } from 'vitest';

export interface RecordingClient extends RootAnalytics {
  shutdown: ReturnType<typeof vi.fn>;
  page: ReturnType<typeof vi.fn>;
  track: ReturnType<typeof vi.fn>;
}

export function createRecordingClient(): RecordingClient {
  const scoped: ScopedAnalytics = {
    track: vi.fn(),
    page: vi.fn(),
    group: vi.fn(),
  };
  return {
    track: vi.fn(),
    identify: vi.fn(),
    page: vi.fn(),
    group: vi.fn(),
    reset: vi.fn(),
    setTraits: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    optIn: vi.fn(),
    optOut: vi.fn(),
    hasOptedOut: vi.fn(() => false),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    context: vi.fn(() => scoped),
  } as RecordingClient;
}
