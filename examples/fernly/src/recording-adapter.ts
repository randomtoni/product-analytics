import type {
  AnalyticsAdapter,
  ConsentState,
  NeutralEvent,
  NeutralFetchResponse,
  NeutralProperties,
  NeutralTraits,
  RegisterOptions,
  ResetOptions,
} from 'analytics-kit';

const LIBRARY_ID = 'fernly-example';
const LIBRARY_VERSION = '0.0.0';

export interface IdentifyRecord {
  distinctId: string;
  traits?: NeutralTraits;
  traitsOnce?: NeutralTraits;
}

export interface RegisterRecord {
  props: NeutralProperties;
  options?: RegisterOptions;
}

export interface GroupRecord {
  type: string;
  key: string;
  traits?: NeutralTraits;
}

export interface AliasRecord {
  previousId: string;
  distinctId: string;
}

export interface PersistedPropertyRecord {
  key: string;
  value: unknown;
}

export interface MergeLink {
  anonymousId: string;
  identifiedId: string;
}

export class RecordingAdapter implements AnalyticsAdapter {
  readonly captures: NeutralEvent[] = [];
  readonly identifies: IdentifyRecord[] = [];
  readonly registers: RegisterRecord[] = [];
  readonly unregisters: string[] = [];
  readonly resets: ResetOptions[] = [];
  readonly groups: GroupRecord[] = [];
  readonly aliases: AliasRecord[] = [];
  readonly consentStates: ConsentState[] = [];
  readonly persistedProperties: PersistedPropertyRecord[] = [];
  readonly merges: MergeLink[] = [];

  private distinctId: string = crypto.randomUUID();
  private identified = false;

  capture(event: NeutralEvent): void {
    this.captures.push(event);
  }

  identify(distinctId: string, traits?: NeutralTraits, traitsOnce?: NeutralTraits): void {
    this.identifies.push({ distinctId, traits, traitsOnce });
    if (distinctId === this.distinctId) {
      return;
    }
    if (!this.identified) {
      this.merges.push({ anonymousId: this.distinctId, identifiedId: distinctId });
    }
    this.distinctId = distinctId;
    this.identified = true;
  }

  register(props: NeutralProperties, options?: RegisterOptions): void {
    this.registers.push({ props, options });
  }

  unregister(key: string): void {
    this.unregisters.push(key);
  }

  reset(options?: ResetOptions): void {
    this.resets.push(options ?? {});
    this.distinctId = crypto.randomUUID();
    this.identified = false;
  }

  getDistinctId(): string {
    return this.distinctId;
  }

  group(type: string, key: string, traits?: NeutralTraits): void {
    this.groups.push({ type, key, traits });
  }

  alias(previousId: string, distinctId: string): void {
    this.aliases.push({ previousId, distinctId });
  }

  async flush(): Promise<void> {}

  async shutdown(): Promise<void> {}

  getConsentState(): ConsentState {
    return 'granted';
  }

  setConsentState(state: ConsentState): void {
    this.consentStates.push(state);
  }

  fetch(): Promise<NeutralFetchResponse> {
    return Promise.resolve({
      status: 0,
      text: async () => '',
      json: async () => ({}),
    });
  }

  setPersistedProperty<T>(key: string, value: T | null): void {
    this.persistedProperties.push({ key, value });
  }

  getPersistedProperty<T>(): T | undefined {
    return undefined;
  }

  getLibraryId(): string {
    return LIBRARY_ID;
  }

  getLibraryVersion(): string {
    return LIBRARY_VERSION;
  }

  getCustomUserAgent(): string | undefined {
    return undefined;
  }
}
