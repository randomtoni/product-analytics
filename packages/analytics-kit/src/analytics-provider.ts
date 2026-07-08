import type { AnalyticsAdapter } from './adapter';
import type { NeutralEvent, NeutralProperties, NeutralTraits } from './neutral-event';
import { NoopAdapter } from './noop-adapter';
import type { FeatureFlagPort, SessionReplayPort } from './ports';
import { RESERVED_PAGE_EVENT } from './taxonomy';
import type { DefaultTaxonomyShape, PropsParam, TaxonomyShape } from './taxonomy';
import { generateUuid as defaultGenerateUuid } from './uuid';

const ANONYMOUS_DISTINCT_ID = 'anonymous';

export type ViolationPolicy = 'throw' | 'drop-and-error-log';

type ConsoleLike = { error(...args: unknown[]): void };

function emitViolation(message: string): void {
  (globalThis as { console?: ConsoleLike }).console?.error?.(message);
}

export interface AnalyticsProvider<TX extends TaxonomyShape = DefaultTaxonomyShape> {
  track<K extends keyof TX['events'] & string>(
    event: K,
    ...args: PropsParam<TX['events'][K]>
  ): void;
  identify(id: string, traits?: Partial<TX['traits']>, traitsOnce?: Partial<TX['traits']>): void;
  page(name?: string, props?: NeutralProperties): void;
  group<G extends keyof TX['groups'] & string>(
    type: G,
    key: string,
    props?: TX['groups'][G]
  ): void;
  reset(): void;
  setTraits(traits: Partial<TX['traits']>, once?: boolean): void;
  optIn(): void;
  optOut(): void;
  hasOptedOut(): boolean;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  flags?: FeatureFlagPort;
  replay?: SessionReplayPort;
}

export class AnalyticsProviderImpl implements AnalyticsProvider {
  private adapter!: AnalyticsAdapter;
  private liveAdapter: AnalyticsAdapter;
  private readonly noopAdapter = new NoopAdapter();
  private optedOut = false;
  private readonly allowlist?: ReadonlySet<string>;
  private readonly onViolation: ViolationPolicy;
  private readonly generateUuid: () => string;

  constructor(
    adapter: AnalyticsAdapter,
    allowlist?: string[],
    onViolation?: ViolationPolicy,
    generateUuid: () => string = defaultGenerateUuid
  ) {
    this.liveAdapter = adapter;
    this.resyncActiveAdapter();
    this.allowlist = allowlist === undefined ? undefined : new Set(allowlist);
    this.onViolation = onViolation ?? 'throw';
    this.generateUuid = generateUuid;
  }

  installAdapter(next: AnalyticsAdapter): void {
    this.liveAdapter = next;
    this.resyncActiveAdapter();
  }

  track(event: string, props?: NeutralProperties): void {
    if (!this.allowed(props)) return;
    this.adapter.capture(this.buildEvent(event, props));
  }

  page(name?: string, props?: NeutralProperties): void {
    if (!this.allowed(props)) return;
    this.adapter.capture(this.buildEvent(name ?? RESERVED_PAGE_EVENT, props));
  }

  identify(id: string, traits?: NeutralTraits, traitsOnce?: NeutralTraits): void {
    if (!this.allowed(traits, traitsOnce)) return;
    this.adapter.identify(id, traits, traitsOnce);
  }

  group(type: string, key: string, props?: NeutralTraits): void {
    if (!this.allowed(props)) return;
    this.adapter.group(type, key, props);
  }

  setTraits(traits: NeutralTraits, once?: boolean): void {
    if (!this.allowed(traits)) return;
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
    this.optedOut = true;
    this.resyncActiveAdapter();
  }

  optIn(): void {
    this.optedOut = false;
    this.resyncActiveAdapter();
  }

  hasOptedOut(): boolean {
    return this.optedOut;
  }

  flush(): Promise<void> {
    return this.liveAdapter.flush();
  }

  shutdown(): Promise<void> {
    return this.liveAdapter.shutdown();
  }

  private resyncActiveAdapter(): void {
    this.adapter = this.optedOut ? this.noopAdapter : this.liveAdapter;
  }

  private allowed(...bags: Array<NeutralProperties | undefined>): boolean {
    const allowlist = this.allowlist;
    if (allowlist === undefined) return true;
    for (const bag of bags) {
      if (bag === undefined) continue;
      for (const key of Object.keys(bag)) {
        if (allowlist.has(key)) continue;
        const message = `analytics-kit: property "${key}" is not on the payload allowlist`;
        if (this.onViolation === 'throw') {
          throw new Error(message);
        }
        emitViolation(message);
        return false;
      }
    }
    return true;
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
      dedupeId: this.generateUuid(),
    };
  }
}
