import type { AnalyticsAdapter } from './adapter';
import type { NeutralEvent, NeutralProperties, NeutralTraits } from './neutral-event';
import { NoopAdapter } from './noop-adapter';
import type { FeatureFlagPort, SessionReplayPort } from './ports';
import { generateUuid } from './uuid';

const ANONYMOUS_DISTINCT_ID = 'anonymous';
const DEFAULT_PAGE_NAME = 'page';

export interface AnalyticsProvider {
  track(event: string, props?: NeutralProperties): void;
  identify(id: string, traits?: NeutralTraits, traitsOnce?: NeutralTraits): void;
  page(name?: string, props?: NeutralProperties): void;
  group(type: string, key: string, props?: NeutralTraits): void;
  reset(): void;
  setTraits(traits: NeutralTraits, once?: boolean): void;
  optIn(): void;
  optOut(): void;
  hasOptedOut(): boolean;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  flags?: FeatureFlagPort;
  replay?: SessionReplayPort;
}

export class AnalyticsProviderImpl implements AnalyticsProvider {
  private adapter: AnalyticsAdapter;
  private liveAdapter: AnalyticsAdapter;
  private readonly noopAdapter = new NoopAdapter();
  private optedOut = false;

  constructor(adapter: AnalyticsAdapter) {
    this.liveAdapter = adapter;
    this.adapter = adapter;
  }

  track(event: string, props?: NeutralProperties): void {
    this.adapter.capture(this.buildEvent(event, props));
  }

  page(name?: string, props?: NeutralProperties): void {
    this.adapter.capture(this.buildEvent(name ?? DEFAULT_PAGE_NAME, props));
  }

  identify(id: string, traits?: NeutralTraits, traitsOnce?: NeutralTraits): void {
    this.adapter.identify(id, traits, traitsOnce);
  }

  group(type: string, key: string, props?: NeutralTraits): void {
    this.adapter.group(type, key, props);
  }

  setTraits(traits: NeutralTraits, once?: boolean): void {
    if (once) {
      this.adapter.identify(this.currentDistinctId(), undefined, traits);
    } else {
      this.adapter.identify(this.currentDistinctId(), traits);
    }
  }

  reset(): void {
    // Real behavior (clear identity + regenerate anon id) lands in E4; no-op skeleton for now.
  }

  optOut(): void {
    this.adapter = this.noopAdapter;
    this.optedOut = true;
  }

  optIn(): void {
    this.adapter = this.liveAdapter;
    this.optedOut = false;
  }

  hasOptedOut(): boolean {
    return this.optedOut;
  }

  flush(): Promise<void> {
    return this.adapter.flush();
  }

  shutdown(): Promise<void> {
    return this.adapter.shutdown();
  }

  private currentDistinctId(): string {
    return ANONYMOUS_DISTINCT_ID;
  }

  private buildEvent(event: string, props?: NeutralProperties): NeutralEvent {
    return {
      event,
      distinctId: this.currentDistinctId(),
      properties: props,
      timestamp: new Date(),
      dedupeId: generateUuid(),
    };
  }
}
