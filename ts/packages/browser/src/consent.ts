import type { ConsentState } from 'analytics-kit';
import type { StorageBackend } from './storage-backends';

const YES_LIKE: ReadonlySet<unknown> = new Set([true, 'true', 1, '1', 'yes']);

// A platform Do-Not-Track / Global-Privacy-Control signal, read from the several
// places browsers expose it. This is [WIRE]/platform mechanics folded into the
// resolved consent INSIDE the adapter — it is never a neutral-surface concept.
export function platformDoNotTrack(): boolean {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const win = typeof window === 'undefined' ? undefined : window;
  const signals: unknown[] = [
    nav?.doNotTrack,
    (nav as { msDoNotTrack?: unknown } | undefined)?.msDoNotTrack,
    (nav as { globalPrivacyControl?: unknown } | undefined)?.globalPrivacyControl,
    (win as { doNotTrack?: unknown } | undefined)?.doNotTrack,
  ];
  return signals.some((signal) => YES_LIKE.has(signal));
}

function isConsentState(value: unknown): value is ConsentState {
  return value === 'granted' || value === 'denied' || value === 'pending';
}

// A durable single-value store for the consent decision, held under a dedicated
// name on a backend separate from the property store it gates. The decision VALUE
// is read once at construction and cached; that value read is side-effect-free
// (the capability probe that PICKS the backend — localStorageBackend.isSupported()
// — does write/remove a probe key, but that is the caller's concern, not this
// read). A DNT/GPC signal collapses the resolved value to denied so the caller
// sees ONE tri-state.
export class ConsentStore {
  private readonly backend: StorageBackend;
  private readonly name: string;
  private stored: ConsentState;

  constructor(backend: StorageBackend, name: string) {
    this.backend = backend;
    this.name = name;
    this.stored = this.read();
  }

  private read(): ConsentState {
    const raw = this.backend.get(this.name);
    if (raw === null) {
      return 'pending';
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isConsentState(parsed) ? parsed : 'pending';
    } catch {
      return 'pending';
    }
  }

  get(): ConsentState {
    if (platformDoNotTrack()) {
      return 'denied';
    }
    return this.stored;
  }

  set(state: ConsentState): void {
    this.stored = state;
    this.backend.set(this.name, state);
  }
}
