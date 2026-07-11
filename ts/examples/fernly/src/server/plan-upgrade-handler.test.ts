import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import type { FetchLike, NodeAnalyticsConfig } from '@randomtoni/analytics-kit-node';
import {
  createFernlyServerAnalytics,
  createShutdownHandler,
  handlePlanUpgrade,
  registerShutdownHandler,
  type PlanUpgrade,
} from './plan-upgrade-handler';

interface WireEvent {
  uuid: string;
  event: string;
  distinct_id: string;
  properties?: Record<string, unknown>;
}

interface WireBatch {
  api_key: string;
  batch: WireEvent[];
}

// A mock transport standing in for a real ingest endpoint: node's public injection seam
// is `config.fetch` (it has no injectable adapter), so a fetch that decodes + records the
// delivered batch is how the server target runs against a mock with no real POST. The
// delivery is gzipped by default; decode via the Content-Encoding header the sender set.
function createRecordingTransport(): {
  fetch: FetchLike;
  deliveries: WireBatch[];
} {
  const deliveries: WireBatch[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const encoding = new Headers(init.headers).get('Content-Encoding');
    const body = init.body as string | Uint8Array;
    const json = encoding === 'gzip' ? gunzipSync(body as Uint8Array).toString('utf8') : (body as string);
    deliveries.push(JSON.parse(json) as WireBatch);
    return new Response(null, { status: 200 });
  }) as unknown as FetchLike;
  return { fetch, deliveries };
}

function baseConfig(fetch: FetchLike): Omit<NodeAnalyticsConfig, 'taxonomy'> {
  return { key: 'ingest-write-key', ingestHost: 'https://ingest.mock.test', fetch };
}

function upgradeFor(distinctId: string, dedupeId: string): PlanUpgrade {
  return {
    reviewerId: distinctId,
    reviewerEmail: 'reviewer@fernly.example',
    role: 'admin',
    workspaceKey: 'ws_acme',
    workspaceName: 'Acme',
    seats: 25,
    fromPlan: 'free',
    toPlan: 'pro',
    at: new Date('2026-07-09T10:00:00.000Z'),
    billingEventId: dedupeId,
  };
}

function planUpgradedEvents(deliveries: WireBatch[]): WireEvent[] {
  return deliveries.flatMap((d) => d.batch).filter((e) => e.event === 'plan_upgraded');
}

describe('Fernly node-side server capture of plan_upgraded (E7, sibling of the browser client)', () => {
  it('captures plan_upgraded on the same distinct id and carries the dedupeId as the wire uuid', async () => {
    const { fetch, deliveries } = createRecordingTransport();
    const analytics = createFernlyServerAnalytics(baseConfig(fetch));

    const distinctId = 'reviewer_42';
    const dedupeId = 'billing_evt_abc';
    analytics.capture(
      distinctId,
      'plan_upgraded',
      { fromPlan: 'free', toPlan: 'pro', at: new Date('2026-07-09T10:00:00.000Z') },
      { dedupeId }
    );

    // Node BATCHES — nothing leaves until a flush trigger. Force the drain, then read the POST.
    await analytics.flush();

    const events = planUpgradedEvents(deliveries);
    expect(events).toHaveLength(1);
    expect(events[0]!.distinct_id).toBe(distinctId);
    // The dedupeId lands on the WIRE as the top-level `uuid`, NOT as a `dedupeId` field.
    expect(events[0]!.uuid).toBe(dedupeId);
    expect(events[0]).not.toHaveProperty('dedupeId');
    expect(events[0]!.properties).toMatchObject({ fromPlan: 'free', toPlan: 'pro' });
  });

  it('routes the whole upgrade handler (capture + traits) to delivery on the same distinct id', async () => {
    const { fetch, deliveries } = createRecordingTransport();
    const analytics = createFernlyServerAnalytics(baseConfig(fetch));

    const distinctId = 'reviewer_client_shared';
    const dedupeId = 'billing_evt_shared';
    handlePlanUpgrade(analytics, upgradeFor(distinctId, dedupeId));

    await analytics.flush();

    const events = planUpgradedEvents(deliveries);
    expect(events).toHaveLength(1);
    // Keyed on the SAME distinct id a client-side slice would use.
    expect(events[0]!.distinct_id).toBe(distinctId);
    expect(events[0]!.uuid).toBe(dedupeId);

    // setTraits rides the same transport, keyed on the same distinct id (server-side property update).
    const traitEvents = deliveries.flatMap((d) => d.batch).filter((e) => e.event === 'set_traits');
    expect(traitEvents).toHaveLength(1);
    expect(traitEvents[0]!.distinct_id).toBe(distinctId);
    expect(traitEvents[0]!.properties).toMatchObject({ set: { plan: 'pro' } });
  });

  it('yields the SAME wire uuid twice for a duplicate dedupeId — backend-dedupe idempotency, client does NOT drop', async () => {
    const { fetch, deliveries } = createRecordingTransport();
    const analytics = createFernlyServerAnalytics(baseConfig(fetch));

    const dedupeId = 'billing_evt_retry';
    const props = { fromPlan: 'free', toPlan: 'pro', at: new Date('2026-07-09T10:00:00.000Z') };

    // Same event delivered twice with the same dedupeId (an idempotent-retry replay).
    analytics.capture('reviewer_7', 'plan_upgraded', props, { dedupeId });
    analytics.capture('reviewer_7', 'plan_upgraded', props, { dedupeId });
    await analytics.flush();

    const uuids = planUpgradedEvents(deliveries).map((e) => e.uuid);
    // The client does NOT collapse the duplicate — both reach the wire carrying the SAME
    // uuid. Idempotency is the backend's job, keyed on that shared uuid.
    expect(uuids).toEqual([dedupeId, dedupeId]);
  });

  it('mints a distinct wire uuid per capture when no dedupeId is supplied', async () => {
    const { fetch, deliveries } = createRecordingTransport();
    const analytics = createFernlyServerAnalytics(baseConfig(fetch));

    const props = { fromPlan: 'free', toPlan: 'pro', at: new Date('2026-07-09T10:00:00.000Z') };
    analytics.capture('reviewer_8', 'plan_upgraded', props);
    analytics.capture('reviewer_8', 'plan_upgraded', props);
    await analytics.flush();

    const uuids = planUpgradedEvents(deliveries).map((e) => e.uuid);
    expect(uuids).toHaveLength(2);
    expect(uuids[0]).not.toBe(uuids[1]);
    expect(uuids[0]).toBeTruthy();
  });

  it("a signal handler awaits shutdown(): the drain window is used and shutdown resolves (not rejects)", async () => {
    const { fetch, deliveries } = createRecordingTransport();
    const analytics = createFernlyServerAnalytics(baseConfig(fetch));

    // Buffer an event WITHOUT flushing — only the shutdown drain should deliver it.
    analytics.capture('reviewer_9', 'plan_upgraded', {
      fromPlan: 'free',
      toPlan: 'pro',
      at: new Date('2026-07-09T10:00:00.000Z'),
    }, { dedupeId: 'billing_evt_shutdown' });

    expect(deliveries).toHaveLength(0);

    const handler = createShutdownHandler(analytics);
    // The handler awaits shutdown() so the drain window is used — resolves, never rejects.
    await expect(handler()).resolves.toBeUndefined();

    // The buffered event was drained + delivered by shutdown().
    const events = planUpgradedEvents(deliveries);
    expect(events).toHaveLength(1);
    expect(events[0]!.uuid).toBe('billing_evt_shutdown');
  });

  it('is a whole-stack no-op when unkeyed — nothing is delivered (bar B)', async () => {
    const { fetch, deliveries } = createRecordingTransport();
    // No `key` -> NodeNoop: never constructs transport, sends nothing.
    const analytics = createFernlyServerAnalytics({ ingestHost: 'https://ingest.mock.test', fetch });

    handlePlanUpgrade(analytics, upgradeFor('reviewer_10', 'billing_evt_noop'));
    await analytics.flush();
    await expect(analytics.shutdown()).resolves.toBeUndefined();

    expect(fetch).not.toHaveBeenCalled();
    expect(deliveries).toHaveLength(0);
  });

  it('registers SIGTERM/SIGINT handlers that await shutdown when a signal fires', async () => {
    const { fetch } = createRecordingTransport();
    const analytics = createFernlyServerAnalytics(baseConfig(fetch));
    const shutdownSpy = vi.spyOn(analytics, 'shutdown');

    const handler = registerShutdownHandler(analytics);
    await handler();

    expect(shutdownSpy).toHaveBeenCalledTimes(1);
    process.removeListener('SIGTERM', handler);
    process.removeListener('SIGINT', handler);
  });
});
