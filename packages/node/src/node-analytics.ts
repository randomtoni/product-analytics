import { randomUUID } from 'node:crypto';
import {
  deriveAllowlistFromTaxonomy,
  enforceAllowlist,
  type NeutralEvent,
  type NeutralProperties,
  type NeutralTraits,
  type PropDecl,
  type TaxonomyShape,
} from 'analytics-kit';
import type { NodeAnalyticsConfig, ViolationPolicy } from './config';
import { BatchQueue } from './batch-queue';
import {
  SET_GROUP_TRAITS_EVENT,
  SET_TRAITS_EVENT,
  WIRE_GROUP_KEY_KEY,
  WIRE_GROUP_SET_KEY,
  WIRE_GROUP_TYPE_KEY,
  WIRE_SET_KEY,
  WIRE_SET_ONCE_KEY,
} from './wire-mapper';

export type CaptureOptions = { dedupeId?: string };

// The queue→delivery seam: a batch delivery callback the client injects into the
// queue. In this story the client supplies an internal stub (or a test-injected
// spy); the real gzipped wire POST fills this closure in E7-S4 with zero queue
// reshaping. Kept off the public NodeAnalytics surface — pure adapter plumbing.
export type SendBatch = (batch: NeutralEvent[]) => Promise<void>;

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
  setTraits(distinctId: string, traits: TX['traits'], once?: boolean): void;
  setGroupTraits<G extends keyof TX['groups'] & string>(
    groupType: G,
    groupKey: string,
    traits: TX['groups'][G]
  ): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30000;

export class NodeAnalyticsClient<TX extends TaxonomyShape> implements NodeAnalytics<TX> {
  private readonly allowlist?: ReadonlySet<string>;
  private readonly onViolation: ViolationPolicy;
  private readonly eventDecls?: Readonly<Record<string, PropDecl>>;
  private readonly queue: BatchQueue<NeutralEvent>;
  private readonly shutdownTimeoutMs: number;
  private stopped = false;

  // `send` is the injected delivery seam. Unset ⇒ an internal no-op stub (the real
  // wire POST lands in E7-S4); tests inject a spy to observe the delivered batches.
  constructor(config: NodeAnalyticsConfig, send: SendBatch = async () => {}) {
    const allowlist =
      config.allowlist ??
      (config.taxonomy === undefined ? undefined : deriveAllowlistFromTaxonomy(config.taxonomy));
    this.allowlist = allowlist === undefined ? undefined : new Set(allowlist);
    this.onViolation = config.onViolation ?? 'throw';
    this.eventDecls = config.taxonomy?.decl.events;
    this.shutdownTimeoutMs = config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.queue = new BatchQueue<NeutralEvent>({
      send,
      flushAt: config.flushAt,
      flushInterval: config.flushInterval,
      maxBatchSize: config.maxBatchSize,
      maxQueueSize: config.maxQueueSize,
    });
  }

  capture(
    distinctId: string,
    event: string,
    propsOrOptions?: object,
    options?: CaptureOptions
  ): void {
    if (this.stopped) return;
    const { props, dedupeId } = this.splitArgs(event, propsOrOptions, options);

    if (!enforceAllowlist(this.allowlist, this.onViolation, props)) return;

    const built: NeutralEvent = {
      event,
      distinctId,
      properties: props,
      timestamp: new Date(),
      dedupeId: dedupeId ?? randomUUID(),
    };
    this.queue.enqueue(built);
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

  // Set person properties server-side. The raw trait bag is gated BEFORE minting (an
  // off-list key fails loudly, bar A), then stashed under the neutral wrapper key at
  // mint; the wire-mapper renames it to the de-branded nested `[set]`/`[set_once]`.
  // `once === true` routes the bag to the set-once (first-touch) key, else the set key.
  setTraits(distinctId: string, traits: NeutralTraits, once?: boolean): void {
    if (this.stopped) return;
    if (!enforceAllowlist(this.allowlist, this.onViolation, traits)) return;

    const properties: NeutralProperties = {
      [once === true ? WIRE_SET_ONCE_KEY : WIRE_SET_KEY]: traits,
    };
    this.enqueueInternal(SET_TRAITS_EVENT, distinctId, properties);
  }

  // Set group/cohort properties server-side. `distinctId` defaults to the de-branded
  // `${groupType}_${groupKey}` composite (no persisted server identity). The raw trait
  // bag is gated before minting; groupType/groupKey are routing identifiers, not
  // consumer properties, so they are not gated. The wire-mapper renames the wrapper
  // keys to the de-branded `[group_type]`/`[group_key]`/`[group_set]` nested shape.
  setGroupTraits(groupType: string, groupKey: string, traits: NeutralTraits): void {
    if (this.stopped) return;
    if (!enforceAllowlist(this.allowlist, this.onViolation, traits)) return;

    const properties: NeutralProperties = {
      [WIRE_GROUP_TYPE_KEY]: groupType,
      [WIRE_GROUP_KEY_KEY]: groupKey,
      [WIRE_GROUP_SET_KEY]: traits,
    };
    this.enqueueInternal(SET_GROUP_TRAITS_EVENT, `${groupType}_${groupKey}`, properties);
  }

  // Mint + enqueue an adapter-internal event (trait/group), riding the SAME queue and
  // delivery as capture — a minted dedupeId feeds the wire `uuid`.
  private enqueueInternal(
    event: string,
    distinctId: string,
    properties: NeutralProperties
  ): void {
    this.queue.enqueue({
      event,
      distinctId,
      properties,
      timestamp: new Date(),
      dedupeId: randomUUID(),
    });
  }

  // Force-send the buffered queue immediately (bypassing the size/interval trigger) and
  // resolve once the in-flight POST(s) settle. Per-request cleanup that keeps the client
  // usable afterward — unlike shutdown, it does not quiesce.
  async flush(): Promise<void> {
    await this.queue.flushNow();
  }

  // Drain the queue and quiesce for process exit. Setting `stopped` FIRST makes any
  // consumer capture racing in during the drain inert (the "no new work once shutdown
  // starts" invariant), so no post-shutdown enqueue can re-arm delivery. The drain loop
  // re-flushes until the buffer is empty, catching queue-internal residue that lands
  // during a flush's in-flight await, raced against a configurable timeout so the process
  // never hangs on a wedged backend. On timeout we RESOLVE (not reject) with a warning —
  // shutdown completing is not an error, and a rejecting shutdown in a signal handler is
  // an unhandled-rejection footgun; any still-buffered in-memory events are left unsent by
  // design (ephemeral server, no disk persistence). A final drain clears the queue timers
  // so the client is fully quiesced.
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        console.error(
          'Timed out while shutting down analytics; some events may not have been sent.'
        );
        resolve();
      }, this.shutdownTimeoutMs);
    });

    try {
      await Promise.race([this.drainLoop(), timeout]);
    } finally {
      clearTimeout(timeoutHandle);
      this.queue.drain();
    }
  }

  private async drainLoop(): Promise<void> {
    while (this.queue.size > 0) {
      await this.queue.flushNow();
    }
  }
}
