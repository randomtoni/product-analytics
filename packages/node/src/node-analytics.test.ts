import { defineTaxonomy } from 'analytics-kit';
import type { NeutralEvent } from 'analytics-kit';
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
// is what rejects it (the compile-time rejection is pinned in typing.test.ts).
const offListProps = { amount: 1, rogue: 'x' } as { amount: number };

test('off-list props key throws under the default throw policy — nothing minted', () => {
  const { client, sink } = keyedClient();

  expect(() => client.capture('user-1', 'order_placed', offListProps)).toThrow(
    /not on the payload allowlist/
  );
  flush();
  expect(sink.delivered).toHaveLength(0);
});

test('off-list props key under drop-and-error-log drops the event and logs — nothing minted', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { client, sink } = keyedClient({ onViolation: 'drop-and-error-log' });

  client.capture('user-1', 'order_placed', offListProps);
  flush();

  expect(sink.delivered).toHaveLength(0);
  expect(spy).toHaveBeenCalledWith(expect.stringContaining('not on the payload allowlist'));
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

test('setTraits off-list trait key throws under the default policy — nothing minted', () => {
  const { client, sink } = keyedClient();
  const offList = { plan: 'pro', rogue: 'x' } as { plan: string };

  expect(() => client.setTraits('user-1', offList)).toThrow(/not on the payload allowlist/);
  flush();
  expect(sink.delivered).toHaveLength(0);
});

test('setTraits off-list trait key under drop-and-error-log drops + logs — nothing minted', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { client, sink } = keyedClient({ onViolation: 'drop-and-error-log' });
  const offList = { plan: 'pro', rogue: 'x' } as { plan: string };

  client.setTraits('user-1', offList);
  flush();

  expect(sink.delivered).toHaveLength(0);
  expect(spy).toHaveBeenCalledWith(expect.stringContaining('not on the payload allowlist'));
});

test('setGroupTraits off-list trait key throws under the default policy — nothing minted', () => {
  const { client, sink } = keyedClient();
  const offList = { name: 'Acme', rogue: 'x' } as { name: string };

  expect(() => client.setGroupTraits('company', 'acme', offList)).toThrow(
    /not on the payload allowlist/
  );
  flush();
  expect(sink.delivered).toHaveLength(0);
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

// --- lifecycle skeletons resolve (real bodies E7-S6) ---

test('flush() and shutdown() are async no-op skeletons that resolve', async () => {
  const { client } = keyedClient();

  await expect(client.flush()).resolves.toBeUndefined();
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
