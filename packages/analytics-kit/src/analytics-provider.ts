import type { AnalyticsAdapter, ConsentState } from './adapter';
import { enforceAllowlist } from './allowlist';
import type {
  EnrichmentProfile,
  NeutralEvent,
  NeutralProperties,
  NeutralTraits,
} from './neutral-event';
import { NoopAdapter } from './noop-adapter';
import type { FeatureFlagPort, SessionReplayPort } from './ports';
import { RESERVED_PAGE_EVENT } from './taxonomy';
import type { DefaultTaxonomyShape, PropsParam, TaxonomyShape } from './taxonomy';
import { generateUuid as defaultGenerateUuid } from './uuid';

// The subset of a capture profile a scoped view varies live per event (E6-S8): the
// enrichment toggles + geoip flag, resolved from a named context's profile. Structural,
// so the impl stays decoupled from AnalyticsConfig's CaptureProfile/EnrichmentConfig.
// Must track EnrichmentProfile in lockstep — if a future per-event toggle lands, add it to both.
interface ContextProfile {
  enrichment?: {
    page?: boolean;
    device?: boolean;
    referrer?: boolean;
    utm?: boolean;
    country?: { disableGeoip?: boolean };
  };
}

export type ViolationPolicy = 'throw' | 'drop-and-error-log';

export type ConsentDefault = 'granted' | 'denied';

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

// A narrower per-context view (E6-S8): ONLY the capture-time verbs a profile varies.
// Identity/consent/lifecycle verbs (identify/reset/optIn/optOut/flush/shutdown) are
// deliberately absent — they operate on the shared root, and offering them on a
// per-context handle is a footgun. The three verbs carry the SAME taxonomy-typed
// signatures as the root (S1's tightened `page` shape included), so a consumer's
// declared props type-check through the scoped view identically.
export interface ScopedAnalytics<TX extends TaxonomyShape = DefaultTaxonomyShape> {
  track<K extends keyof TX['events'] & string>(
    event: K,
    ...args: PropsParam<TX['events'][K]>
  ): void;
  page(name?: string, props?: TX['page']): void;
  group<G extends keyof TX['groups'] & string>(
    type: G,
    key: string,
    props?: TX['groups'][G]
  ): void;
}

// The widened root return type (E6-S8): the full pinned `AnalyticsProvider` surface PLUS
// the `context()` accessor. `context()` is carried HERE — never added to the frozen
// `AnalyticsProvider` interface — so the 15-member `keyof AnalyticsProvider` pin is
// untouched. `context(name)` returns a scoped view that applies the named profile while
// delegating identity/session/transport to the shared core.
export interface RootAnalytics<TX extends TaxonomyShape = DefaultTaxonomyShape>
  extends AnalyticsProvider<TX> {
  context(name: string): ScopedAnalytics<TX>;
}

export class AnalyticsProviderImpl implements RootAnalytics {
  private adapter!: AnalyticsAdapter;
  private liveAdapter: AnalyticsAdapter;
  private readonly noopAdapter = new NoopAdapter();
  private optedOut: boolean;
  private readonly consentDefault?: ConsentDefault;
  private readonly allowlist?: ReadonlySet<string>;
  private readonly onViolation: ViolationPolicy;
  private readonly generateUuid: () => string;
  private readonly contexts: Readonly<Record<string, ContextProfile>>;

  constructor(
    adapter: AnalyticsAdapter,
    allowlist?: string[],
    onViolation?: ViolationPolicy,
    generateUuid: () => string = defaultGenerateUuid,
    consentDefault?: ConsentDefault,
    contexts?: Record<string, ContextProfile>
  ) {
    this.liveAdapter = adapter;
    this.consentDefault = consentDefault;
    this.optedOut = this.resolveOptedOut(adapter.getConsentState());
    this.resyncActiveAdapter();
    this.allowlist = allowlist === undefined ? undefined : new Set(allowlist);
    this.onViolation = onViolation ?? 'throw';
    this.generateUuid = generateUuid;
    this.contexts = contexts ?? {};
  }

  // Return a narrower scoped view for a named context (E6-S8). The view's capture verbs
  // apply the resolved profile's per-event enrichment while DELEGATING identity/session/
  // transport to this shared core (same distinct id, cookie, session, transport) — so
  // cross-context funnel stitching is preserved. An unknown name yields the empty profile
  // (no enrichment override) — capture still runs on the shared core.
  context(name: string): ScopedAnalytics {
    return new ScopedView(this, this.resolveEnrichmentProfile(name));
  }

  // Flatten a named context profile into the per-event override the adapter reads. Absent
  // members leave the adapter on its own instance-level config (the top-level default).
  private resolveEnrichmentProfile(name: string): EnrichmentProfile | undefined {
    const enrichment = this.contexts[name]?.enrichment;
    if (enrichment === undefined) {
      return undefined;
    }
    // Passing every toggle (even all-undefined) is safe ONLY because each is opt-out-by-absence:
    // the adapter reads `!== false`, so an undefined member leaves that module on its own default.
    // Only `country.disableGeoip` (a wire flag) is per-event; a per-context `country.countrySource`
    // is deliberately NOT threaded — the country VALUE is instance-global (resolved once at init and
    // register()'d as a super-property), so there is no per-event channel a scoped view could honor.
    return {
      page: enrichment.page,
      device: enrichment.device,
      referrer: enrichment.referrer,
      utm: enrichment.utm,
      disableGeoip: enrichment.country?.disableGeoip,
    };
  }

  // Profile-aware capture entries used by a scoped view. They reuse the SAME allowlist
  // gate, consent-swap, and buildEvent path as the root verbs — the only difference is
  // that the resolved enrichment profile rides the minted event, so the adapter varies
  // its live per-event enrichment for this context.
  trackWithProfile(event: string, props: NeutralProperties | undefined, profile?: EnrichmentProfile): void {
    if (!this.allowed(props)) return;
    this.adapter.capture(this.buildEvent(event, props, undefined, profile));
  }

  pageWithProfile(name: string | undefined, props: NeutralProperties | undefined, profile?: EnrichmentProfile): void {
    if (!this.allowed(props)) return;
    this.adapter.capture(this.buildEvent(name ?? RESERVED_PAGE_EVENT, props, true, profile));
  }

  groupWithProfile(type: string, key: string, props: NeutralTraits | undefined): void {
    // group() routes through the adapter's group() path, not capture() — it carries no
    // per-event enrichment to vary, so no profile is threaded. It still gates and delegates
    // to the shared core exactly like the root group().
    if (!this.allowed(props)) return;
    this.adapter.group(type, key, props);
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
    this.adapter.capture(this.buildEvent(name ?? RESERVED_PAGE_EVENT, props, true));
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
    return enforceAllowlist(this.allowlist, this.onViolation, ...bags);
  }

  // Identity is orthogonal to consent: read the live adapter, not the
  // consent-swapped one, so the distinct id stays truthful while opted out.
  private currentDistinctId(): string {
    return this.liveAdapter.getDistinctId();
  }

  private buildEvent(
    event: string,
    props?: NeutralProperties,
    isPageView?: true,
    enrichmentProfile?: EnrichmentProfile
  ): NeutralEvent {
    const built: NeutralEvent = {
      event,
      distinctId: this.currentDistinctId(),
      properties: props,
      timestamp: new Date(),
      dedupeId: this.generateUuid(),
    };
    if (isPageView) {
      built.isPageView = true;
    }
    if (enrichmentProfile !== undefined) {
      built.enrichmentProfile = enrichmentProfile;
    }
    return built;
  }
}

// A lightweight per-context handle (E6-S8). It exposes ONLY the three capture verbs and
// forwards each to the shared impl's profile-aware entries, carrying its resolved
// enrichment profile. It holds NO identity/session/transport state of its own — every
// call delegates to the shared core, so two contexts share one distinct id + session.
class ScopedView implements ScopedAnalytics {
  constructor(
    private readonly root: AnalyticsProviderImpl,
    private readonly profile?: EnrichmentProfile
  ) {}

  track(event: string, props?: NeutralProperties): void {
    this.root.trackWithProfile(event, props, this.profile);
  }

  page(name?: string, props?: NeutralProperties): void {
    this.root.pageWithProfile(name, props, this.profile);
  }

  group(type: string, key: string, props?: NeutralTraits): void {
    this.root.groupWithProfile(type, key, props);
  }
}
