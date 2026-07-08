import { randomUUID } from 'node:crypto';
import {
  deriveAllowlistFromTaxonomy,
  enforceAllowlist,
  type NeutralEvent,
  type NeutralProperties,
  type PropDecl,
  type TaxonomyShape,
} from 'analytics-kit';
import type { NodeAnalyticsConfig, ViolationPolicy } from './config';
import { InMemoryEventBuffer, type EventBuffer } from './event-buffer';

export type CaptureOptions = { dedupeId?: string };

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type EmptyObject = {};

// The taxonomy-typed public capture surface. Two overloads (props-bearing FIRST, then
// no-props via a never-narrowed event) each carry a trailing options bag — a single
// variadic props tuple cannot host a trailing arg, and folding options into the tuple
// would swallow a { dedupeId } into the props slot for a no-props event.
export interface NodeCapture<TX extends TaxonomyShape> {
  <K extends keyof TX['events'] & string>(
    distinctId: string,
    event: K,
    props: TX['events'][K],
    options?: CaptureOptions
  ): void;
  <K extends keyof TX['events'] & string>(
    distinctId: string,
    event: EmptyObject extends TX['events'][K] ? K : never,
    options?: CaptureOptions
  ): void;
}

export interface NodeAnalytics<TX extends TaxonomyShape> {
  capture: NodeCapture<TX>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export class NodeAnalyticsClient<TX extends TaxonomyShape> implements NodeAnalytics<TX> {
  private readonly allowlist?: ReadonlySet<string>;
  private readonly onViolation: ViolationPolicy;
  private readonly eventDecls?: Readonly<Record<string, PropDecl>>;
  private readonly buffer: EventBuffer;

  constructor(config: NodeAnalyticsConfig, buffer: EventBuffer = new InMemoryEventBuffer()) {
    const allowlist =
      config.allowlist ??
      (config.taxonomy === undefined ? undefined : deriveAllowlistFromTaxonomy(config.taxonomy));
    this.allowlist = allowlist === undefined ? undefined : new Set(allowlist);
    this.onViolation = config.onViolation ?? 'throw';
    this.eventDecls = config.taxonomy?.decl.events;
    this.buffer = buffer;
  }

  capture(
    distinctId: string,
    event: string,
    propsOrOptions?: object,
    options?: CaptureOptions
  ): void {
    const { props, dedupeId } = this.splitArgs(event, propsOrOptions, options);

    if (!enforceAllowlist(this.allowlist, this.onViolation, props)) return;

    const built: NeutralEvent = {
      event,
      distinctId,
      properties: props,
      timestamp: new Date(),
      dedupeId: dedupeId ?? randomUUID(),
    };
    this.buffer.add(built);
  }

  // Resolve the impl's widened (propsOrOptions?, options?) into (props, dedupeId) from
  // POSITION + the taxonomy declaration — never from the runtime shape of the bag (a
  // `{}` props bag and a `{}` options bag are indistinguishable). arg4 present ⇒ arg3 is
  // props. arg4 absent + arg3 present is the only ambiguous form: an event with declared
  // non-empty props reads arg3 as props; a declared-empty or untyped event reads it as
  // options (a no-props event has nothing to put in the props slot).
  private splitArgs(
    event: string,
    propsOrOptions: object | undefined,
    options: CaptureOptions | undefined
  ): { props?: NeutralProperties; dedupeId?: string } {
    if (options !== undefined) {
      return { props: propsOrOptions as NeutralProperties | undefined, dedupeId: options.dedupeId };
    }
    if (propsOrOptions === undefined) {
      return {};
    }
    // arg3 present, arg4 absent — the only ambiguous form. arg3 is the OPTIONS bag ONLY
    // when a taxonomy declares this event with empty props (a genuine no-props event has
    // nothing for the props slot). Under an untyped taxonomy (the escape hatch) arg3 is
    // always props: predictable and never-lossy beats swallowing a real prop into options.
    const decl = this.eventDecls?.[event];
    const isDeclaredNoProps = decl !== undefined && Object.keys(decl).length === 0;
    if (isDeclaredNoProps) {
      return { dedupeId: (propsOrOptions as CaptureOptions).dedupeId };
    }
    return { props: propsOrOptions as NeutralProperties };
  }

  // Real force-drain body lands in E7-S6.
  async flush(): Promise<void> {}

  // Real drain-within-timeout body lands in E7-S6.
  async shutdown(): Promise<void> {}
}
