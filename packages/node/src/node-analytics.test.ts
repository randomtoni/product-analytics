import { createAnalytics, defineTaxonomy, NoopAdapter } from 'analytics-kit';
import type { AnalyticsAdapter, NeutralEvent } from 'analytics-kit';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NodeAnalyticsClient, type SendBatch } from './node-analytics';
import { mapEventToWire } from './wire-mapper';

const taxonomy = defineTaxonomy({
  events: {
    order_placed: { amount: 'number' },
    logged_out: {},
  },
  traits: { plan: 'string', seats: 'number' },
  groups: {
    company: { name: 'string', size: 'number' },
  },
});

// The delivery seam observed by tests: a spy that flattens every delivered batch into
// a single stream of events. The size-triggered flush is deferred (a 0ms timer), so a
// test advances timers after a capture to observe the delivered events.
function collectingSend() {
  const batches: NeutralEvent[][] = [];
  const send: SendBatch = async (batch) => {
    batches.push(batch);
  };
  return {
    send,
    batches,
    get delivered(): NeutralEvent[] {
      return batches.flat();
    },
  };
}

// flushAt: 1 so each capture size-triggers immediately; the content of the minted event
// is what these client-level tests assert (queue timing is covered in batch-queue.test.ts).
function keyedClient(overrides = {}) {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, flushAt: 1, ...overrides },
    sink.send
  );
  return { client, sink };
}

// Drive the deferred size-flush to completion so `sink.delivered` reflects the captures.
function flush(): void {
  vi.advanceTimersByTime(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('capture with props mints a NeutralEvent stamped with distinctId/event/properties/timestamp', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 42 });
  flush();

  const [event] = sink.delivered;
  expect(event.distinctId).toBe('user-1');
  expect(event.event).toBe('order_placed');
  expect(event.properties).toEqual({ amount: 42 });
  expect(event.timestamp).toBeInstanceOf(Date);
});

test('a no-props event captures with no properties bag', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'logged_out');
  flush();

  const [event] = sink.delivered;
  expect(event.event).toBe('logged_out');
  expect(event.properties).toBeUndefined();
});

// --- dedupeId: mint vs caller-supplied ---

test('no caller dedupeId → NeutralEvent.dedupeId is populated (minted)', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 1 });
  flush();

  const [event] = sink.delivered;
  expect(typeof event.dedupeId).toBe('string');
  expect(event.dedupeId.length).toBeGreaterThan(0);
});

test('two minted dedupeIds are distinct (retry substrate)', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 1 });
  client.capture('user-1', 'order_placed', { amount: 2 });
  flush();

  const [a, b] = sink.delivered;
  expect(a.dedupeId).not.toBe(b.dedupeId);
});

test('caller dedupeId with props → carried onto NeutralEvent.dedupeId verbatim', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 1 }, { dedupeId: 'dd-props' });
  flush();

  const [event] = sink.delivered;
  expect(event.dedupeId).toBe('dd-props');
});

test('caller dedupeId on a no-props event → carried verbatim (arg3 is the options bag)', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'logged_out', { dedupeId: 'dd-noprops' });
  flush();

  const [event] = sink.delivered;
  expect(event.event).toBe('logged_out');
  expect(event.dedupeId).toBe('dd-noprops');
  expect(event.properties).toBeUndefined();
});

test('a no-props event with no options still mints a dedupeId', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'logged_out');
  flush();

  const [event] = sink.delivered;
  expect(typeof event.dedupeId).toBe('string');
  expect(event.dedupeId.length).toBeGreaterThan(0);
});

// --- distinctId required (runtime is enforced by the type; assert it lands verbatim) ---

test('distinctId is the exact first-arg value on the minted event', () => {
  const { client, sink } = keyedClient();

  client.capture('acct-server-actor', 'order_placed', { amount: 1 });
  flush();

  const [event] = sink.delivered;
  expect(event.distinctId).toBe('acct-server-actor');
});

// --- server-side allowlist gate (bar A) ---

// The off-list bag is assembled behind a widening so the runtime guard — not the compiler —
// is what would reject it if a guard were active (the compile-time rejection is pinned in
// typing.test.ts).
const offListProps = { amount: 1, rogue: 'x' } as { amount: number };

// A taxonomy alone does NOT activate the runtime guard — it is a typing decision, not a
// privacy decision. With no explicit allowlist supplied, an off-taxonomy key passes through
// UNGATED, mirroring the seam's posture (packages/analytics-kit/src/allowlist.test.ts:325).
test('a taxonomy alone does NOT activate the guard — an off-taxonomy props key passes through ungated', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'order_placed', offListProps);
  flush();

  expect(sink.delivered).toHaveLength(1);
  expect(sink.delivered[0].properties).toEqual({ amount: 1, rogue: 'x' });
});

test('an on-list props key passes the gate and is minted', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 99 });
  flush();

  expect(sink.delivered).toHaveLength(1);
});

test('an explicit consumer allowlist gates server capture too', () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient({ key: 'k', allowlist: ['amount'], flushAt: 1 }, sink.send);

  client.capture('user-1', 'order_placed', { amount: 1 });
  flush();
  expect(sink.delivered).toHaveLength(1);

  expect(() => client.capture('user-1', 'order_placed', { rogue: 'x' })).toThrow(
    /not on the payload allowlist/
  );
});

test('with no taxonomy and no allowlist, every prop is allowed (undefined allowlist)', () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient({ key: 'k', flushAt: 1 }, sink.send);

  client.capture('user-1', 'anything', { whatever: true });
  flush();
  expect(sink.delivered).toHaveLength(1);
});

// Bar A parity: the SAME { taxonomy, no explicit allowlist } config is ungated on BOTH the seam
// and node — a taxonomy is a typing decision, not a privacy decision, so it does not auto-activate
// the guard on either platform. This pins the fix for the node-vs-seam divergence.
test('node-vs-seam parity: { taxonomy, no allowlist } is ungated on both — off-taxonomy key reaches delivery', () => {
  const seamTaxonomy = defineTaxonomy({
    events: { signed_up: { plan: 'string' } },
  });

  // Seam side: taxonomy present, no explicit allowlist ⇒ guard inactive, off-taxonomy key reaches
  // the adapter (mirrors packages/analytics-kit/src/allowlist.test.ts:325).
  const captured: NeutralEvent[] = [];
  const adapter: AnalyticsAdapter = new NoopAdapter();
  adapter.capture = (event: NeutralEvent): void => {
    captured.push(event);
  };
  adapter.getConsentState = (): 'granted' => 'granted';
  const seam = createAnalytics({ taxonomy: seamTaxonomy, consentDefault: 'granted' }, adapter);
  // @ts-expect-error off_taxonomy_key is not part of signed_up's declared props
  seam.track('signed_up', { off_taxonomy_key: 1 });
  expect(captured).toHaveLength(1);
  expect(captured[0].properties).toEqual({ off_taxonomy_key: 1 });

  // Node side: same config posture (taxonomy present, no explicit allowlist) ⇒ same ungated verdict.
  const sink = collectingSend();
  const client = new NodeAnalyticsClient({ key: 'k', taxonomy, flushAt: 1 }, sink.send);
  client.capture('user-1', 'order_placed', offListProps);
  flush();
  expect(sink.delivered).toHaveLength(1);
  expect(sink.delivered[0].properties).toEqual({ amount: 1, rogue: 'x' });
});

// --- browser-only NeutralEvent fields stay unset ---

test('server-minted NeutralEvent leaves isPageView/sessionId/enrichmentProfile unset', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 1 });
  flush();

  const [event] = sink.delivered;
  expect(event.isPageView).toBeUndefined();
  expect(event.sessionId).toBeUndefined();
  expect(event.enrichmentProfile).toBeUndefined();
});

// --- config threads the queue knobs into the client ---

test('config.flushAt threads into the queue: a flushAt-sized burst delivers, sub-flushAt does not', () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient({ key: 'k', taxonomy, flushAt: 3 }, sink.send);

  client.capture('u', 'order_placed', { amount: 1 });
  client.capture('u', 'order_placed', { amount: 2 });
  flush();
  expect(sink.batches).toHaveLength(0);

  client.capture('u', 'order_placed', { amount: 3 });
  flush();
  expect(sink.batches).toHaveLength(1);
  expect(sink.delivered).toHaveLength(3);
});

test('config.flushInterval threads into the queue: a sub-flushAt buffer delivers after the interval', () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, flushAt: 20, flushInterval: 500 },
    sink.send
  );

  client.capture('u', 'order_placed', { amount: 1 });
  expect(sink.batches).toHaveLength(0);

  vi.advanceTimersByTime(500);
  expect(sink.batches).toHaveLength(1);
  expect(sink.delivered).toHaveLength(1);
});

test('config.maxBatchSize threads into the queue: a deep buffer slices per delivery', () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, flushAt: 5, maxBatchSize: 2 },
    sink.send
  );

  for (let i = 0; i < 5; i++) {
    client.capture('u', 'order_placed', { amount: i });
  }
  flush();

  expect(sink.batches.map((b) => b.length)).toEqual([2, 2, 1]);
});

// --- setTraits / setGroupTraits: mint through the same queue + wire ---

test('setTraits mints a set-traits event that rides the same queue (delivered gzipped-batch path)', () => {
  const { client, sink } = keyedClient();

  client.setTraits('user-1', { plan: 'pro', seats: 5 });
  flush();

  const [event] = sink.delivered;
  expect(event.event).toBe('set_traits');
  expect(event.distinctId).toBe('user-1');
  const wire = mapEventToWire(event);
  expect(wire.properties).toEqual({ set: { plan: 'pro', seats: 5 } });
});

test('setTraits(once=true) routes the bag to the set-once key at the wire, not set', () => {
  const { client, sink } = keyedClient();

  client.setTraits('user-1', { plan: 'pro' }, true);
  flush();

  const [event] = sink.delivered;
  const wire = mapEventToWire(event);
  expect(wire.properties).toEqual({ set_once: { plan: 'pro' } });
  expect(wire.properties).not.toHaveProperty('set');
});

test('setTraits(once=false or omitted) routes the bag to the set key', () => {
  const { client, sink } = keyedClient();

  client.setTraits('user-1', { plan: 'pro' });
  client.setTraits('user-1', { plan: 'pro' }, false);
  flush();

  for (const event of sink.delivered) {
    const wire = mapEventToWire(event);
    expect(wire.properties).toEqual({ set: { plan: 'pro' } });
    expect(wire.properties).not.toHaveProperty('set_once');
  }
});

test('setTraits mints a dedupeId → wire uuid (idempotent transport, same as capture)', () => {
  const { client, sink } = keyedClient();

  client.setTraits('user-1', { plan: 'pro' });
  flush();

  const [event] = sink.delivered;
  const wire = mapEventToWire(event);
  expect(typeof wire.uuid).toBe('string');
  expect(wire.uuid.length).toBeGreaterThan(0);
});

test('setGroupTraits mints a group event with the composite distinctId default', () => {
  const { client, sink } = keyedClient();

  client.setGroupTraits('company', 'acme', { name: 'Acme', size: 200 });
  flush();

  const [event] = sink.delivered;
  expect(event.event).toBe('set_group_traits');
  expect(event.distinctId).toBe('company_acme');
  const wire = mapEventToWire(event);
  expect(wire.properties).toEqual({
    group_type: 'company',
    group_key: 'acme',
    group_set: { name: 'Acme', size: 200 },
  });
});

// A taxonomy alone does NOT activate the trait guard either — with no explicit allowlist the
// off-taxonomy trait key passes through ungated (typing decision ≠ privacy decision). Explicit
// allowlist gating of traits is pinned separately below.
test('setTraits with a taxonomy alone does NOT gate — an off-taxonomy trait key passes through ungated', () => {
  const { client, sink } = keyedClient();
  const offList = { plan: 'pro', rogue: 'x' } as { plan: string };

  client.setTraits('user-1', offList);
  flush();

  const [event] = sink.delivered;
  expect(mapEventToWire(event).properties).toEqual({ set: { plan: 'pro', rogue: 'x' } });
});

// An EXPLICIT consumer allowlist still gates traits — an off-list key fails loudly, nothing minted.
test('setTraits with an explicit allowlist gates an off-list trait key — throws, nothing minted', () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient({ key: 'k', allowlist: ['plan'], flushAt: 1 }, sink.send);
  const offList = { plan: 'pro', rogue: 'x' } as { plan: string };

  expect(() => client.setTraits('user-1', offList)).toThrow(/not on the payload allowlist/);
  flush();
  expect(sink.delivered).toHaveLength(0);
});

test('setTraits with an explicit allowlist under drop-and-error-log drops + logs — nothing minted', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const sink = collectingSend();
  const client = new NodeAnalyticsClient(
    { key: 'k', allowlist: ['plan'], onViolation: 'drop-and-error-log', flushAt: 1 },
    sink.send
  );
  const offList = { plan: 'pro', rogue: 'x' } as { plan: string };

  client.setTraits('user-1', offList);
  flush();

  expect(sink.delivered).toHaveLength(0);
  expect(spy).toHaveBeenCalledWith(expect.stringContaining('not on the payload allowlist'));
});

test('setGroupTraits with an explicit allowlist gates an off-list trait key — throws, nothing minted', () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient({ key: 'k', allowlist: ['name'], flushAt: 1 }, sink.send);
  const offList = { name: 'Acme', rogue: 'x' } as { name: string };

  expect(() => client.setGroupTraits('company', 'acme', offList)).toThrow(
    /not on the payload allowlist/
  );
  flush();
  expect(sink.delivered).toHaveLength(0);
});

// A taxonomy alone does NOT gate group traits either — off-taxonomy key passes through ungated.
test('setGroupTraits with a taxonomy alone does NOT gate — an off-taxonomy trait key passes through ungated', () => {
  const { client, sink } = keyedClient();
  const offList = { name: 'Acme', rogue: 'x' } as { name: string };

  client.setGroupTraits('company', 'acme', offList);
  flush();

  const [event] = sink.delivered;
  expect(mapEventToWire(event).properties).toEqual({
    group_type: 'company',
    group_key: 'acme',
    group_set: { name: 'Acme', rogue: 'x' },
  });
});

test('the raw wrapper key (`set`) is not itself allowlist-gated — the raw trait keys are', () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient(
    { key: 'k', allowlist: ['plan'], flushAt: 1 },
    sink.send
  );

  client.setTraits('user-1', { plan: 'pro' });
  flush();
  expect(sink.delivered).toHaveLength(1);
});

test('traits and captures ride the SAME queue and batch together', () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient({ key: 'k', taxonomy, flushAt: 3 }, sink.send);

  client.capture('user-1', 'order_placed', { amount: 1 });
  client.setTraits('user-1', { plan: 'pro' });
  flush();
  expect(sink.batches).toHaveLength(0);

  client.setGroupTraits('company', 'acme', { name: 'Acme' });
  flush();

  expect(sink.batches).toHaveLength(1);
  expect(sink.delivered).toHaveLength(3);
  expect(sink.delivered.map((e) => e.event)).toEqual([
    'order_placed',
    'set_traits',
    'set_group_traits',
  ]);
});

// --- flush(): force-drain bypassing the trigger, resolve once POSTs settle ---

test('flush() force-drains the buffer before the interval elapses and resolves', async () => {
  const sink = collectingSend();
  // flushAt high + interval long: nothing would ship on its own before flush().
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, flushAt: 20, flushInterval: 10000 },
    sink.send
  );

  client.capture('u', 'order_placed', { amount: 1 });
  expect(sink.delivered).toHaveLength(0); // no trigger fired yet

  await client.flush();
  expect(sink.delivered).toHaveLength(1); // force-drained before any trigger
  expect(sink.delivered[0]?.event).toBe('order_placed');
});

test('flush() resolves only once the in-flight delivery settles', async () => {
  let resolveDelivery: () => void = () => {};
  const send: SendBatch = () =>
    new Promise<void>((r) => {
      resolveDelivery = r;
    });
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, flushAt: 20, flushInterval: 10000 },
    send
  );

  client.capture('u', 'order_placed', { amount: 1 });
  const flushed = client.flush();

  let settled = false;
  void flushed.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false); // the POST has not resolved yet

  resolveDelivery();
  await flushed;
  expect(settled).toBe(true);
});

test('flush() leaves the client usable — a later capture still ships', async () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, flushAt: 20, flushInterval: 10000 },
    sink.send
  );

  client.capture('u', 'order_placed', { amount: 1 });
  await client.flush();
  expect(sink.delivered).toHaveLength(1);

  client.capture('u', 'order_placed', { amount: 2 });
  await client.flush();
  expect(sink.delivered).toHaveLength(2);
});

// --- shutdown(): drain-until-empty, catch mid-drain enqueue, quiesce ---

test('shutdown() drains the buffer and resolves', async () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, flushAt: 20, flushInterval: 10000 },
    sink.send
  );

  client.capture('u', 'order_placed', { amount: 1 });
  await expect(client.shutdown()).resolves.toBeUndefined();
  expect(sink.delivered).toHaveLength(1);
});

test('shutdown() drains ALL buffered pre-shutdown work, re-flushing across the loop', async () => {
  const sink = collectingSend();
  // maxBatchSize=1 → the buffered burst slices into several deliveries; the drain must
  // sweep every one before resolving, not just the first slice.
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, flushAt: 20, flushInterval: 10000, maxBatchSize: 1 },
    sink.send
  );

  for (let i = 0; i < 5; i++) client.capture('u', 'order_placed', { amount: i });
  await client.shutdown();

  expect(sink.delivered).toHaveLength(5);
  expect(sink.delivered.map((e) => e.properties?.amount)).toEqual([0, 1, 2, 3, 4]);
});

// A consumer capture racing in AFTER shutdown began is inert by design (stopped-at-top,
// the "no new work once shutdown starts" invariant) — so the drain loop's "catch events
// enqueued mid-drain" behavior is exercised at the QUEUE seam (batch-queue.test.ts:
// "the loop re-drains a buffer that refills during a flush's in-flight await"), where a
// refill that lands during flushNow's await is the real, non-consumer mid-drain case.
// This client-level test pins the complementary invariant: the consumer path is inert.
test('a capture fired DURING shutdown (mid-drain) is inert — not shipped, stopped-at-top', async () => {
  const sink = collectingSend();
  let racedIn = false;
  const send: SendBatch = async (batch) => {
    sink.batches.push(batch);
    if (!racedIn) {
      racedIn = true;
      // The consumer races a capture in mid-drain; stopped is already true → inert.
      client.capture('u', 'order_placed', { amount: 99 });
    }
  };
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, flushAt: 20, flushInterval: 10000 },
    send
  );

  client.capture('u', 'order_placed', { amount: 1 });
  await client.shutdown();

  expect(sink.delivered).toHaveLength(1);
  expect(sink.delivered.map((e) => e.properties?.amount)).toEqual([1]);
});

test('shutdown() with an empty buffer resolves immediately (nothing to drain)', async () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient({ key: 'k', taxonomy }, sink.send);

  await expect(client.shutdown()).resolves.toBeUndefined();
  expect(sink.delivered).toHaveLength(0);
});

// --- shutdown() timeout: deterministic settle, not hung ---

test('shutdown() settles deterministically on timeout when a delivery hangs — process not hung', async () => {
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // A delivery that never resolves: without the timeout race, shutdown would hang forever.
  const send: SendBatch = () => new Promise<void>(() => {});
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, flushAt: 20, flushInterval: 10000, shutdownTimeoutMs: 5000 },
    send
  );

  client.capture('u', 'order_placed', { amount: 1 });
  const shutdown = client.shutdown();

  let settled = false;
  void shutdown.then(() => {
    settled = true;
  });

  await vi.advanceTimersByTimeAsync(4999);
  expect(settled).toBe(false); // still within the timeout

  await vi.advanceTimersByTimeAsync(1); // timeout fires
  await shutdown;
  expect(settled).toBe(true); // resolved, not hung
  expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('may not have been sent'));
});

test('shutdownTimeoutMs is configurable — the drain window honors the override', async () => {
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const send: SendBatch = () => new Promise<void>(() => {});
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, flushAt: 20, flushInterval: 10000, shutdownTimeoutMs: 100 },
    send
  );

  client.capture('u', 'order_placed', { amount: 1 });
  const shutdown = client.shutdown();

  let settled = false;
  void shutdown.then(() => {
    settled = true;
  });

  await vi.advanceTimersByTimeAsync(99);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await shutdown;
  expect(settled).toBe(true);
  expect(errSpy).toHaveBeenCalled();
});

// --- post-shutdown quiesce: timer cleared, later capture inert (no re-arm) ---

test('after shutdown() a later capture is inert — nothing ships, no delivery timer re-arms', async () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, flushAt: 20, flushInterval: 10000 },
    sink.send
  );

  client.capture('u', 'order_placed', { amount: 1 });
  await client.shutdown();
  expect(sink.delivered).toHaveLength(1);

  client.capture('u', 'order_placed', { amount: 2 });
  // No re-arm: advancing well past the interval fires no delivery.
  vi.advanceTimersByTime(100000);
  expect(sink.delivered).toHaveLength(1);
});

test('after shutdown() setTraits and setGroupTraits are also inert', async () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, flushAt: 20, flushInterval: 10000 },
    sink.send
  );

  await client.shutdown();

  client.setTraits('u', { plan: 'pro' });
  client.setGroupTraits('company', 'acme', { name: 'Acme' });
  vi.advanceTimersByTime(100000);
  expect(sink.delivered).toHaveLength(0);
});

test('a second shutdown() is a no-op and resolves', async () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient({ key: 'k', taxonomy }, sink.send);

  await client.shutdown();
  await expect(client.shutdown()).resolves.toBeUndefined();
});

// --- zero browser coupling ---

test('node source imports nothing from @analytics-kit/browser', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const browserPkg = ['@analytics-kit', 'browser'].join('/');
  const files = readdirSync(__dirname).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')
  );
  for (const file of files) {
    const contents = readFileSync(join(__dirname, file), 'utf8');
    expect(contents).not.toContain(browserPkg);
  }
});
