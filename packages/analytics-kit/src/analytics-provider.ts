import type { AnalyticsAdapter, ConsentState } from './adapter';
import type { NeutralEvent, NeutralProperties, NeutralTraits } from './neutral-event';
import { NoopAdapter } from './noop-adapter';
import type { FeatureFlagPort, SessionReplayPort } from './ports';
import { RESERVED_PAGE_EVENT } from './taxonomy';
import type { DefaultTaxonomyShape, PropsParam, TaxonomyShape } from './taxonomy';
import { generateUuid as defaultGenerateUuid } from './uuid';

export type ViolationPolicy = 'throw' | 'drop-and-error-log';

export type ConsentDefault = 'granted' | 'denied';

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
  page(name?: string, props?: TX['page']): void;
  group<G extends keyof TX['groups'] & string>(
    type: G,
    key: string,
    props?: TX['groups'][G]
  ): void;
  reset(options?: { resetDevice?: boolean }): void;
  setTraits(traits: Partial<TX['traits']>, once?: boolean): void;
  register(props: NeutralProperties, options?: { once?: boolean }): void;
  unregister(key: string): void;
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
  private optedOut: boolean;
  private readonly consentDefault?: ConsentDefault;
  private readonly allowlist?: ReadonlySet<string>;
  private readonly onViolation: ViolationPolicy;
  private readonly generateUuid: () => string;

  constructor(
    adapter: AnalyticsAdapter,
    allowlist?: string[],
    onViolation?: ViolationPolicy,
    generateUuid: () => string = defaultGenerateUuid,
    consentDefault?: ConsentDefault
  ) {
    this.liveAdapter = adapter;
    this.consentDefault = consentDefault;
    this.optedOut = this.resolveOptedOut(adapter.getConsentState());
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

  register(props: NeutralProperties, options?: { once?: boolean }): void {
    // Gate the incoming super-props at registration — the ONE consumer-supplied
    // source that flows downstream into every event — reusing the E3 whole-bag
    // drop/throw semantics verbatim. Stored super-props are trusted at merge time
    // because they crossed the gate here.
    if (!this.allowed(props)) return;
    this.adapter.register(props, options);
  }

  unregister(key: string): void {
    // Gate consistently with register: a key not on the allowlist behaves like an
    // off-list track key (throw / drop-and-error-log). Routing the removal through
    // the consent-swappable adapter keeps it inert under opt-out.
    // The `undefined` sentinel is sound ONLY because allowed() inspects Object.keys
    // and never the values — if allowed() ever starts inspecting values, pass a real
    // presence sentinel here instead.
    if (!this.allowed({ [key]: undefined })) return;
    this.adapter.unregister(key);
  }

  reset(options?: { resetDevice?: boolean }): void {
    // Route to the live adapter, NOT the consent-swapped one: a logout during
    // opt-out must still clear identity (routing to the no-op would leave stale
    // identity — a privacy footgun). The live adapter's own consent posture keeps
    // persistence suppressed, so no cookie is written while opted out.
    this.liveAdapter.reset(options);
  }

  optOut(): void {
    this.optedOut = true;
    // Persist the durable decision and quiesce the live adapter (drop, not flush,
    // any unsent buffer — E5 owns the buffer); then swap the active delegate to
    // the no-op as defense-in-depth.
    this.liveAdapter.setConsentState('denied');
    this.resyncActiveAdapter();
  }

  optIn(): void {
    this.optedOut = false;
    this.liveAdapter.setConsentState('granted');
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

  // 'granted' captures; 'denied' opts out; 'pending' resolves against the config
  // consent-default — unset is opt-out-by-default (the library's fail-safe).
  private resolveOptedOut(state: ConsentState): boolean {
    if (state === 'granted') return false;
    if (state === 'denied') return true;
    return this.consentDefault !== 'granted';
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

  // Identity is orthogonal to consent: read the live adapter, not the
  // consent-swapped one, so the distinct id stays truthful while opted out.
  private currentDistinctId(): string {
    return this.liveAdapter.getDistinctId();
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
